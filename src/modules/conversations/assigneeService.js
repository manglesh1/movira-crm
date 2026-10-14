const { callCore } = require('./guestAiBridge');
async function listAssignees(locationId) { return callCore('assignees', { locationId }); }
async function validateAssignee(locationId, userId) {
  if (userId == null) return;
  const id = Number(userId);
  const fail = () => { throw Object.assign(new Error('Choose an eligible staff member for this park.'), { statusCode: 400, code: 'invalid_assignee' }); };
  if (!Number.isSafeInteger(id) || id < 1) fail();
  const directory = await listAssignees(locationId);
  if (!directory?.items?.some(user => Number(user.id) === id)) fail();
}
module.exports = { listAssignees, validateAssignee };
