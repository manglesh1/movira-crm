const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const permission = require('../src/modules/conversations/routePermission');
test('conversation mutations require the operation-specific policy', () => {
  for (const path of ['/channels/webchat', '/channels/id', '/workspace', '/routing-rules/id']) {
    assert.equal(permission({path,method:'PATCH'}),'crm:settings:write');
  }
  assert.equal(permission({path:'/automation-rules',method:'POST'}),'crm:automation:write');
  assert.equal(permission({path:'/id/assignment',method:'PATCH'}),'crm:contacts:write');
  assert.equal(permission({path:'/channels',method:'GET'}),'crm:read');
});

test('inbox pages, equal-time messages, staff validation, routing and spam regression', {skip:process.env.RUN_UNIFIED_CHAT_DB_TEST!=='1'}, async () => {
  require('dotenv').config();
  const schema=`crm_audit_${randomUUID().replaceAll('-','')}`;
  process.env.CRM_DB_SCHEMA=schema;
  const s=require('../src/db/sequelize').getSequelize();
  const models={sequelize:s,...require('../src/db/models/ConversationModels')(s),CrmContact:require('../src/db/models/CrmContact')(s)};
  for (const [model,alias,key] of [[models.CrmConversationIdentity,'identity','identityId'],[models.CrmContact,'contact','contactId'],[models.CrmConversationChannelConnection,'connection','connectionId']]) models.CrmConversation.belongsTo(model,{as:alias,foreignKey:key});
  models.CrmConversation.hasMany(models.CrmConversationTag,{as:'tags',foreignKey:'conversationId'});
  require('../src/db/models').getModels=()=>models;
  const service=require('../src/modules/conversations/service');
  const routing=require('../src/modules/conversations/routingService');
  const oldFetch=global.fetch;
  global.fetch=async()=>({ok:true,json:async()=>({success:true,data:{items:[{id:2,name:'Eligible staff'}]}})});
  try {
    await s.createSchema(schema); await s.sync();
    const connection=await models.CrmConversationChannelConnection.create({locationId:4,channel:'webchat',provider:'movira',externalAccountId:randomUUID()});
    const identity=await models.CrmConversationIdentity.create({locationId:4,connectionId:connection.id,channel:'webchat',externalUserId:randomUUID()});
    const stamp=new Date('2026-01-01T12:00:00Z');
    const threads=await models.CrmConversation.bulkCreate(Array.from({length:131},(_,i)=>({locationId:4,channel:'webchat',connectionId:connection.id,identityId:identity.id,externalThreadId:randomUUID(),lastMessageAt:i<125?stamp:null,createdAt:stamp,assignedUserId:i===130?2:null,handlingMode:'ai',metadataSafe:{visitor:{name:i===129?'Old searchable guest':'Guest',email:'visitor@example.invalid'}}})));
    const ids=[];let cursor;
    do { const page=await service.listConversations({locationId:4,limit:50,cursor,actorUserId:2}); ids.push(...page.items.map(x=>x.id)); cursor=page.pageInfo.nextCursor; assert.equal(page.total,131);assert.equal(page.counts.mine,1); } while(cursor);
    assert.equal(ids.length,131);assert.equal(new Set(ids).size,131);
    assert.equal((await service.listConversations({locationId:4,search:'Old searchable'})).items[0].id,threads[129].id);
    assert.equal((await service.listConversations({locationId:4,view:'mine',actorUserId:2})).items[0].id,threads[130].id);
    assert.equal((await service.listConversations({locationId:5,search:'guest'})).total,0);
    await models.CrmConversationMessage.bulkCreate(Array.from({length:131},()=>({locationId:4,conversationId:threads[0].id,connectionId:connection.id,direction:'inbound',textBody:'historical message',occurredAt:stamp})));
    const messageIds=[];cursor=null;
    do { const page=await service.listMessages(threads[0].id,{locationId:4,limit:50,cursor});messageIds.push(...page.items.map(x=>x.id));cursor=page.pageInfo.nextCursor;}while(cursor);
    assert.equal(messageIds.length,131);assert.equal(new Set(messageIds).size,131);
    assert.equal((await service.listConversations({locationId:4,search:'historical message'})).items[0].id,threads[0].id);
    await assert.rejects(service.updateAssignment(threads[0].id,{locationId:4,assignedUserId:2147483646},1),{code:'invalid_assignee'});
    await threads[0].reload();assert.equal(threads[0].handlingMode,'ai');
    await service.createRoutingRule({locationId:4,condition:'Message mentions payment',destination:'Sales',priority:'high'},1);
    await s.transaction(tx=>routing.routeInbound(models,threads[0],'A payment problem',tx));
    assert.equal(threads[0].assignedTeamId,'Sales');assert.equal(threads[0].priority,'high');
    await service.updateAssignment(threads[0].id,{locationId:4,assignedUserId:2},1);
    await threads[0].reload();assert.equal(threads[0].handlingMode,'human');
    await assert.rejects(service.createAutomationRule({locationId:4,name:'No-op',trigger:'anything',action:'anything',active:true},1),{code:'automation_unavailable'});
  } finally {global.fetch=oldFetch;await s.dropSchema(schema,{cascade:true});await s.close();}
});
