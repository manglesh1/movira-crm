const MOVIRA_CONTROL_SCOPE = "movira_control";

function plainRecord(value) {
  return typeof value?.get === "function" ? value.get({ plain: true }) : (value || {});
}

function isMoviraControlEvent(eventType) {
  return String(eventType || "").trim().toLowerCase().startsWith("saas.");
}

function isMoviraControlTemplate(template) {
  const row = plainRecord(template);
  return String(row.family || "").trim().toLowerCase() === "saas"
    || row.config?.templateScope === MOVIRA_CONTROL_SCOPE
    || row.defaults?.templateScope === MOVIRA_CONTROL_SCOPE;
}

function isMoviraControlMessage(message) {
  return message?.payload?.templateScope === MOVIRA_CONTROL_SCOPE
    || isMoviraControlEvent(message?.sourceEventType);
}

module.exports = {
  MOVIRA_CONTROL_SCOPE,
  isMoviraControlEvent,
  isMoviraControlMessage,
  isMoviraControlTemplate,
};
