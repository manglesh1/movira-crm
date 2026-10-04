const automationService = require("./service");
const queueJobs = require("../queueJobs/service");

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

async function processAutomationQueueJob(job) {
  const data = plain(job);
  const payload = data.payload || {};
  if (data.jobType === queueJobs.JOB_TYPES.AUTOMATION_ENROLLMENT) {
    if (!payload.enrollmentJobId) throw new Error("automation.enrollment requires payload.enrollmentJobId");
    const summary = await automationService.processAutomationEnrollmentJob(payload.enrollmentJobId);
    return { automationEnrollment: summary };
  }
  if (data.jobType === queueJobs.JOB_TYPES.AUTOMATION_RESUME) {
    if (!payload.runId) throw new Error("automation.resume requires runId");
    return automationService.resumeAutomationRun(payload.runId);
  }

  if (data.jobType !== queueJobs.JOB_TYPES.AUTOMATION_EVENT) {
    throw new Error(`Unsupported automation queue job type: ${data.jobType}`);
  }
  const summary = await automationService.triggerWorkflowsForEvent(payload.event || {});
  return { automation: summary };
}

module.exports = { processAutomationQueueJob };
