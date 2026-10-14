const repository = require("./repository");
const { validateCreateMessage } = require("./validation");
const { enqueueTransactionalMessage } = require("../messaging-core/aws/sqsClient");
const { STATUS } = require("./constants");
const suppressionService = require("../marketing/email/suppressionService");
const emailDeliveryPolicy = require("../../shared/emailDeliveryPolicy");
const { isMoviraControlMessage } = require("../../shared/communicationScope");

function shouldProcessInline(enqueue) {
  if (!enqueue?.skipped || enqueue.reason !== "missing_queue_url") return false;
  if (process.env.TRANSACTIONAL_INLINE_ON_MISSING_QUEUE === "true") return true;
  if (process.env.TRANSACTIONAL_INLINE_ON_MISSING_QUEUE === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function shouldRecoverMessage(message) {
  if (message?.status === STATUS.PENDING) return true;
  return (
    message?.status === STATUS.ENQUEUE_SKIPPED &&
    (String(message?.lastError || "").startsWith("queue_error:") ||
      (message?.lastError === "missing_queue_url" &&
        (process.env.TRANSACTIONAL_INLINE_ON_MISSING_QUEUE === "true" ||
          (process.env.TRANSACTIONAL_INLINE_ON_MISSING_QUEUE !== "false" &&
            process.env.NODE_ENV !== "production"))))
  );
}

function queueUnavailableError(error) {
  const providerCode = String(error?.name || error?.Code || error?.code || "unknown_error")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 120);
  const wrapped = new Error(
    `Transactional email queue is unavailable (${providerCode}). ` +
      "Check the EC2 IAM role and SQS queue configuration."
  );
  wrapped.statusCode = 503;
  wrapped.code = "transactional_queue_unavailable";
  wrapped.cause = error;
  return wrapped;
}

async function enqueueOrReportFailure(message) {
  try {
    const enqueue = await enqueueTransactionalMessage({
      messageId: message.id,
      channel: message.channel,
      priority: message.priority,
    });
    const updated = await repository.markQueued(message, enqueue);
    return { enqueue, updated };
  } catch (error) {
    await repository.markEnqueueFailed(message, error);
    throw queueUnavailableError(error);
  }
}

async function processInline(message) {
  const workerProcessor = require("./workerProcessor");
  const result = await workerProcessor.processTransactionalSqsMessage({
    Body: JSON.stringify({
      messageId: message.id,
      domain: "transactional",
      channel: message.channel,
      priority: message.priority,
    }),
  });
  const refreshed = await repository.findMessageById(message.id);
  return { result, message: refreshed || message };
}

async function enqueueMessage(body) {
  const validation = validateCreateMessage(body);
  if (!validation.ok) {
    const err = new Error(validation.errors.join("; "));
    err.statusCode = 400;
    throw err;
  }

  if (!isMoviraControlMessage(validation.value)) {
    await emailDeliveryPolicy.assertEnabled("transactional", validation.value, { fresh: true });
  }

  const existing = await repository.findByIdempotencyKey(validation.value.idempotencyKey);
  if (existing) {
    if (shouldRecoverMessage(existing)) {
      if (
        existing.status === STATUS.PENDING ||
        String(existing.lastError || "").startsWith("queue_error:")
      ) {
        const recovered = await enqueueOrReportFailure(existing);
        return {
          duplicate: false,
          message: recovered.updated,
          enqueue: recovered.enqueue,
          recovered: true,
        };
      }
      const inline = await processInline(existing);
      return {
        duplicate: false,
        message: inline.message,
        enqueue: {
          skipped: true,
          reason: "missing_queue_url",
          inlineProcessed: true,
        },
        inline: inline.result,
      };
    }

    return {
      duplicate: true,
      message: existing,
      enqueue: null,
    };
  }

  const message = await repository.createMessage(validation.value);
  if (message.channel === "email") {
    const suppression = await suppressionService.isSuppressed(message.locationId, message.recipientAddress);
    if (suppression) {
      const suppressed = await repository.markSuppressed(message, suppression);
      return {
        duplicate: false,
        message: suppressed,
        enqueue: { skipped: true, reason: "recipient_suppressed", suppressionId: suppression.id },
      };
    }
  }
  const { enqueue, updated } = await enqueueOrReportFailure(message);

  if (shouldProcessInline(enqueue)) {
    const inline = await processInline(updated);
    return {
      duplicate: false,
      message: inline.message,
      enqueue: {
        ...enqueue,
        inlineProcessed: true,
      },
      inline: inline.result,
    };
  }

  return {
    duplicate: false,
    message: updated,
    enqueue,
  };
}

module.exports = {
  enqueueMessage,
  _internal: {
    shouldRecoverMessage,
    queueUnavailableError,
  },
};
