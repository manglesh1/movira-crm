const marketingEmailService = require("./service");
const queueJobs = require("../../queueJobs/service");

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

async function processMarketingQueueJob(job) {
  const data = plain(job);
  const payload = data.payload || {};

  if (data.jobType === queueJobs.JOB_TYPES.MARKETING_DRIP_STEP) {
    if (!payload.dripEnrollmentId) throw new Error("marketing.drip_step requires dripEnrollmentId");
    return marketingEmailService.processDripStep(
      payload.dripEnrollmentId,
      payload.stepIndex,
      { attempt: Number(data.attempts || 0), maxAttempts: Number(data.maxAttempts || 3) }
    );
  }
  if (data.jobType === queueJobs.JOB_TYPES.MARKETING_CAMPAIGN_DISPATCH) {
    if (!payload.campaignId) throw new Error("marketing.campaign_dispatch requires campaignId");
    return marketingEmailService.dispatchScheduledCampaign(payload.campaignId, payload.sendRequest || {});
  }
  if (data.jobType === queueJobs.JOB_TYPES.MARKETING_RECIPIENT_BATCH) {
    if (!payload.campaignId || !payload.sendRequest) throw new Error("marketing.recipient_batch requires campaignId and sendRequest");
    return marketingEmailService.dispatchRecipientBatch(payload.campaignId, payload.sendRequest, {
      batchIndex: Number(payload.batchIndex || 0),
      totalBatches: Number(payload.totalBatches || 1),
    });
  }
  if (data.jobType !== queueJobs.JOB_TYPES.MARKETING_CAMPAIGN_AUDIENCE) throw new Error(`Unsupported marketing queue job type: ${data.jobType}`);
  if (!payload.campaignAudienceJobId) {
    throw new Error("marketing.campaign_audience requires payload.campaignAudienceJobId");
  }

  return marketingEmailService.processCampaignAudienceJob(payload.campaignAudienceJobId);
}

module.exports = { processMarketingQueueJob };
