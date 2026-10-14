const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('unified chat: real PostgreSQL sessions, dispatch, handoff, disable, history and isolation', { skip: process.env.RUN_UNIFIED_CHAT_DB_TEST !== '1' }, async () => {
  require('dotenv').config();
  const schema = `crm_chat_test_${crypto.randomBytes(6).toString('hex')}`;
  process.env.CRM_DB_SCHEMA = schema;
  const { getSequelize } = require('../src/db/sequelize');
  const sequelize = getSequelize();
  const models = { sequelize, ...require('../src/db/models/ConversationModels')(sequelize) };
  require('../src/db/models').getModels = () => models;
  const webchat = require('../src/modules/conversations/webchatService');
  const startSession = async input => {
    if (input.sessionToken) return webchat.startSession(input);
    const config = await webchat.getPublicConfig(input.widgetKey, input.origin);
    await new Promise(resolve => setTimeout(resolve, 550));
    return webchat.startSession({ ...input, challenge: config.browserChallenge });
  };
  const orchestration = require('../src/modules/conversations/webchatOrchestration');
  const outbound = require('../src/modules/conversations/outboundService');
  const originalFetch = global.fetch;
  let calls = [], reply = async () => ({ message: 'Opening hours are 10–8.', state: { last_topic: 'hours' } });
  global.fetch = async (url, options) => {
    const action = url.split('/').at(-1); const body = JSON.parse(options.body); calls.push({ action, body });
    const data = action === 'assignees' ? { items: [{ id: 1, name: 'Admin' }, { id: 2, name: 'Staff' }] } : action === 'reply' ? await reply(body) : action === 'lead-form' ? { form: { fields: [] } } : action === 'lead-submit' ? { state: 'success' } : { aiReady: true };
    return { ok: true, json: async () => ({ success: true, data }) };
  };
  const origin = 'https://chat-test.example';
  let n = 0;
  const send = (session, textBody = 'Opening hours?') => webchat.addVisitorMessage({ ...session, origin, textBody, idempotencyKey: `test-${++n}` });
  const flush = async () => {
    for (const event of await outbound.claimSendEvents({ workerId: 'test', limit: 100 })) {
      assert.equal(event.eventType, 'conversation.message.send', 'Normal delivery must never claim AI/contact work');
      await outbound.processSendEvent(event);
    }
    for (const event of await outbound.claimWebchatEvents({ workerId: 'test:webchat', limit: 100 })) {
      assert.ok(['conversation.ai.reply', 'conversation.contact.sync'].includes(event.eventType));
      await orchestration.processEvent(event);
    }
  };
  try {
    await sequelize.createSchema(schema); await sequelize.sync();
    const connection = await webchat.configure({ locationId: 990001, settings: { aiEnabled: false, allowedOrigins: [origin] } });
    const widgetKey = connection.externalAccountId;
    await assert.rejects(webchat.getPublicConfig(widgetKey, ''), { statusCode: 403 });
    await assert.rejects(webchat.getPublicConfig(widgetKey, 'https://evil.example'), { statusCode: 403 });
    await assert.rejects(webchat.startSession({ widgetKey, origin, visitor: { name: 'Bot', email: 'bot@example.invalid' } }), { code: 'browser_check_failed' });
    const human = { widgetKey, ...await startSession({ widgetKey, origin, visitor: { name: 'Test', email: 'test@example.invalid' } }) };
    await send(human); await flush();
    assert.equal(calls.filter(x => x.action === 'reply').length, 0);
    assert.ok(calls.filter(x => x.action === 'contact').length >= 1);
    assert.equal((await webchat.sessionStatus({ ...human, origin })).handlingMode, 'waiting');
    const staff = await outbound.queueReply(human.conversationId, { locationId: 990001, textBody: 'Welcome!' }, 1, 'staff-human-reply');
    await flush();
    assert.equal((await webchat.sessionStatus({ ...human, origin })).handlingMode, 'human');
    assert.ok((await webchat.listVisitorMessages({ ...human, origin })).some(x => x.textBody === 'Welcome!'));
    await webchat.updateConfiguration({ connectionId: connection.id, locationId: 990001, settings: { aiEnabled: true } });
    const ai = { widgetKey, ...await startSession({ widgetKey, origin, visitor: { name: 'AI test', email: 'ai@example.invalid' } }) };
    const sameEmail = { widgetKey, ...await startSession({ widgetKey, origin, visitor: { name: 'Different browser', email: 'ai@example.invalid' } }) };
    assert.notEqual(sameEmail.conversationId, ai.conversationId, 'Unverified email cannot reveal another session history');
    assert.equal((await webchat.listVisitorMessages({ ...sameEmail, origin })).length, 0);
    const message = await send(ai); await flush();
    assert.equal(calls.filter(x => x.action === 'reply').length, 1);
    assert.equal((await webchat.listVisitorMessages({ ...ai, origin })).at(-1).author, 'ai');
    await webchat.addVisitorMessage({ ...ai, origin, textBody: 'Opening hours?', idempotencyKey: message.idempotencyKey });
    assert.equal(await models.CrmConversationMessage.count({ where: { conversationId: ai.conversationId, direction: 'inbound' } }), 1);
    await assert.rejects(webchat.addVisitorMessage({ ...human, origin, textBody: 'test', idempotencyKey: message.idempotencyKey }), { statusCode: 409 });
    await assert.rejects(webchat.listVisitorMessages({ ...ai, sessionToken: 'wrong', origin }), { statusCode: 401 });
    // A human taking over during generation must suppress the delayed AI answer.
    reply = async () => { await orchestration.takeOver(ai.conversationId, 990001, 'human', 1); return { message: 'Must never publish' }; };
    await send(ai, 'Follow-up'); await flush();
    assert.ok(!(await webchat.listVisitorMessages({ ...ai, origin })).some(x => x.textBody === 'Must never publish'));
    assert.equal((await webchat.sessionStatus({ ...ai, origin })).handlingMode, 'human');
    const conversationService = require('../src/modules/conversations/service');
    await conversationService.updateStatus(ai.conversationId,{locationId:990001,status:'spam'});
    const blockedCount = await models.CrmConversationMessage.count({where:{conversationId:ai.conversationId}});
    await assert.rejects(send(ai,'Reopen spam'),{code:'conversation_blocked'});
    await assert.rejects(webchat.handoff({...ai,origin}),{statusCode:409});
    assert.equal(await models.CrmConversationMessage.count({where:{conversationId:ai.conversationId}}),blockedCount);
    await conversationService.updateStatus(ai.conversationId,{locationId:990001,status:'open'});
    await orchestration.returnToAi(ai.conversationId, 990001, 1);
    const beforeBlockedReply = calls.filter(x => x.action === 'reply').length;
    await send(ai, 'Queued before block');
    await conversationService.updateStatus(ai.conversationId,{locationId:990001,status:'spam'});
    await conversationService.updateStatus(ai.conversationId,{locationId:990001,status:'open'});
    await flush();
    assert.equal(calls.filter(x => x.action === 'reply').length,beforeBlockedReply,'reopening must not revive an AI job queued before a block');
    let restored = await models.CrmConversation.findByPk(ai.conversationId);
    assert.equal(restored.handlingMode, 'ai'); assert.equal(restored.assignedUserId, null);
    // Assignment while the provider is generating invalidates that result.
    reply = async () => {
      await conversationService.updateAssignment(ai.conversationId, {locationId:990001,assignedUserId:2}, 1);
      return {message:'Stale answer after assignment'};
    };
    await send(ai, 'Assignment race'); await flush();
    restored = await models.CrmConversation.findByPk(ai.conversationId);
    assert.equal(restored.handlingMode,'human'); assert.equal(restored.assignedUserId,2);
    assert.ok(!(await webchat.listVisitorMessages({...ai,origin})).some(x=>x.textBody==='Stale answer after assignment'));
    const pausedCalls = calls.filter(x=>x.action==='reply').length;
    await send(ai,'While staff is assigned'); await flush();
    assert.equal(calls.filter(x=>x.action==='reply').length,pausedCalls);
    await conversationService.updateAssignment(ai.conversationId,{locationId:990001,assignedUserId:null},1);
    assert.equal((await webchat.sessionStatus({...ai,origin})).handlingMode,'human','unassigning must not silently restart AI');
    await orchestration.returnToAi(ai.conversationId,990001,1);
    const version = (await models.CrmConversation.findByPk(ai.conversationId)).handlingVersion;
    await orchestration.returnToAi(ai.conversationId,990001,1);
    assert.equal((await models.CrmConversation.findByPk(ai.conversationId)).handlingVersion,version,'return is idempotent');
    reply = async()=>({message:'AI resumed after staff handback'});
    await flush(); assert.equal(calls.filter(x=>x.action==='reply').length,pausedCalls,'handback never replays old messages');
    await send(ai,'A new question'); await flush();
    assert.equal((await webchat.listVisitorMessages({...ai,origin})).at(-1).textBody,'AI resumed after staff handback');
    // Returning during an old generation must still invalidate the old version.
    reply = async()=>{
      await conversationService.updateAssignment(ai.conversationId,{locationId:990001,assignedUserId:2},1);
      await orchestration.returnToAi(ai.conversationId,990001,1);
      return {message:'Stale answer across both switches'};
    };
    await send(ai,'Both switches'); await flush();
    assert.ok(!(await webchat.listVisitorMessages({...ai,origin})).some(x=>x.textBody==='Stale answer across both switches'));
    await assert.rejects(orchestration.returnToAi(ai.conversationId,990002,1),{statusCode:404});
    await conversationService.updateStatus(ai.conversationId,{locationId:990001,status:'resolved'});
    await assert.rejects(orchestration.returnToAi(ai.conversationId,990001,1),{statusCode:409});
    await conversationService.updateStatus(ai.conversationId,{locationId:990001,status:'open'});
    await models.CrmConversation.update({channel:'instagram'},{where:{id:ai.conversationId}});
    await assert.rejects(orchestration.returnToAi(ai.conversationId,990001,1),{statusCode:409});
    await models.CrmConversation.update({channel:'webchat'},{where:{id:ai.conversationId}});
    const pending = { widgetKey, ...await startSession({ widgetKey, origin, visitor: { name: 'Pending', email: 'pending@example.invalid' } }) };
    await send(pending);
    await webchat.updateConfiguration({ connectionId: connection.id, locationId: 990001, settings: { aiEnabled: false } });
    await assert.rejects(orchestration.returnToAi(pending.conversationId,990001,1),{statusCode:409});
    const before = calls.filter(x => x.action === 'reply').length; await flush();
    assert.equal(calls.filter(x => x.action === 'reply').length, before);
    assert.equal((await webchat.sessionStatus({ ...pending, origin })).handlingMode, 'waiting');
    await webchat.updateConfiguration({ connectionId: connection.id, locationId: 990001, settings: { aiEnabled: true } });
    assert.equal((await webchat.sessionStatus({ ...pending, origin })).handlingMode, 'waiting');
    const failed = { widgetKey, ...await startSession({ widgetKey, origin, visitor: { name: 'Failure', email: 'failure@example.invalid' } }) };
    reply = async () => { throw new Error('AI offline'); }; await send(failed); await flush();
    assert.equal((await webchat.sessionStatus({ ...failed, origin })).handlingMode, 'waiting');
    assert.equal((await webchat.listVisitorMessages({ ...failed, origin })).at(-1).author, 'system');
    await webchat.handoff({ ...human, origin });
    assert.equal((await webchat.sessionStatus({ ...human, origin })).handlingMode, 'human');
    await webchat.leadRequest({ ...human, origin });
    assert.equal((await webchat.leadRequest({ ...human, origin, submit: true, fields: { full_name: 'Test' } })).state, 'success');
    const other = await webchat.configure({ locationId: 990002, settings: { allowedOrigins: [origin] } });
    await assert.rejects(webchat.listVisitorMessages({ ...human, widgetKey: other.externalAccountId, origin }), { statusCode: 401 });
    await webchat.updateConfiguration({ connectionId: connection.id, locationId: 990001, settings: { enabled: false, aiEnabled: false } });
    await assert.rejects(webchat.getPublicConfig(widgetKey, origin), { statusCode: 404 });
    assert.ok(await models.CrmConversationMessage.count() > 0, 'Disabling preserves history');
    await models.CrmConversationChannelConnection.update({ status: 'disconnected' }, { where: { id: connection.id } });
    const reconnected = await webchat.configure({ locationId: 990001, settings: { allowedOrigins: [origin], aiEnabled: false } });
    assert.equal(reconnected.externalAccountId, widgetKey, 'Reconnect preserves installed URLs');
    assert.equal((await webchat.startSession({ ...human, origin })).conversationId, human.conversationId);
    const config = await webchat.getPublicConfig(widgetKey, origin);
    await new Promise(resolve => setTimeout(resolve, 550));
    await assert.rejects(webchat.startSession({ widgetKey, origin, challenge: config.browserChallenge, company: 'spam', visitor: { name: 'Bot', email: 'bot@example.invalid' } }), { code: 'browser_check_failed' });
    await assert.rejects(webchat.startSession({ widgetKey, origin, challenge: config.browserChallenge, clientIp: 'different-ip', visitor: { name: 'Bot', email: 'bot@example.invalid' } }), { code: 'browser_check_failed' });
    const recentCount = await models.CrmConversationMessage.count({ where: { conversationId: human.conversationId, direction: 'inbound' } });
    for (let index = recentCount; index < 20; index++) await send(human, 'Rate limit test');
    await assert.rejects(send(human, 'One too many'), { code: 'webchat_message_rate_limited' });
  } finally {
    global.fetch = originalFetch;
    await sequelize.dropSchema(schema, { cascade: true }); await sequelize.close();
  }
});
