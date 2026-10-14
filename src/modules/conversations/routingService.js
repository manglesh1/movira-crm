function parseCondition(condition) {
  const value = String(condition || '').trim();
  if (/^new conversation$/i.test(value)) return { kind: 'new' };
  const match = /^message (?:mentions|contains)\s+(.+)$/i.exec(value);
  return match ? { kind: 'text', text: match[1].trim().replace(/^(["'])(.*)\1$/, '$2').toLowerCase() } : null;
}
async function routeInbound(models, conversation, text, transaction) {
  if (conversation.status === 'spam' || conversation.assignedUserId || conversation.handlingMode === 'human' || conversation.metadataSafe?.routingRuleId) return;
  const rules = await models.CrmConversationRoutingRule.findAll({ where: { locationId: conversation.locationId, active: true }, order: [['sortOrder', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']], transaction });
  const rule = rules.find(row => {
    const condition = parseCondition(row.condition);
    return condition?.kind === 'new' ? !conversation.lastMessageId : condition?.kind === 'text' && condition.text && String(text || '').toLowerCase().includes(condition.text);
  });
  if (rule) {
    await conversation.update({ assignedTeamId: rule.destination, priority: rule.priority,
      metadataSafe: { ...(conversation.metadataSafe || {}), routingRuleId: rule.id } }, { transaction });
  } else if (!conversation.assignedTeamId) {
    const workspace = await models.CrmConversationWorkspaceConfig.findOne({ where: { locationId: conversation.locationId }, transaction });
    await conversation.update({ assignedTeamId: workspace?.routing?.fallbackInbox || 'Customer care' }, { transaction });
  }
}
module.exports = { parseCondition, routeInbound };
