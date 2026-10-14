module.exports = function conversationPermission(req) {
  const path = req.path || '/';
  if (req.method === 'GET') return 'crm:read';
  if (/^\/(channels|workspace|routing-rules)(\/|$)/.test(path)) return 'crm:settings:write';
  if (/^\/automation-rules(\/|$)/.test(path)) return 'crm:automation:write';
  return 'crm:contacts:write';
};
