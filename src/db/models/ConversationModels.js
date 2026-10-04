const { DataTypes } = require("sequelize");

const uuid = () => ({ type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true });
const jsonArray = () => ({ type: DataTypes.JSONB, allowNull: false, defaultValue: [] });
const jsonObject = () => ({ type: DataTypes.JSONB, allowNull: false, defaultValue: {} });

function defineConversationModels(sequelize) {
  const CrmConversationChannelConnection = sequelize.define("CrmConversationChannelConnection", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false },
    channel: { type: DataTypes.STRING(40), allowNull: false }, provider: { type: DataTypes.STRING(60), allowNull: false },
    externalAccountId: { type: DataTypes.STRING(255), allowNull: false }, displayName: DataTypes.STRING(255),
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "connecting" },
    encryptedCredentials: DataTypes.TEXT, grantedScopes: jsonArray(), capabilities: jsonObject(),
    tokenExpiresAt: DataTypes.DATE, lastWebhookAt: DataTypes.DATE, lastHealthCheckAt: DataTypes.DATE,
    lastErrorCode: DataTypes.STRING(100), lastErrorMessageSafe: DataTypes.TEXT,
    connectedByUserId: DataTypes.INTEGER, disconnectedAt: DataTypes.DATE,
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  }, { tableName: "crm_conversation_channel_connections", timestamps: true });

  const CrmConversationIdentity = sequelize.define("CrmConversationIdentity", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, connectionId: { type: DataTypes.UUID, allowNull: false },
    contactId: DataTypes.UUID, channel: { type: DataTypes.STRING(40), allowNull: false },
    externalUserId: { type: DataTypes.STRING(255), allowNull: false }, handle: DataTypes.STRING(255),
    displayName: DataTypes.STRING(255), avatarUrlCached: DataTypes.TEXT, profileMetadataSafe: jsonObject(),
    matchMethod: DataTypes.STRING(40), matchConfidence: DataTypes.DECIMAL(5, 4), linkedByUserId: DataTypes.INTEGER,
    linkedAt: DataTypes.DATE, unlinkedAt: DataTypes.DATE, lastSeenAt: DataTypes.DATE,
  }, { tableName: "crm_conversation_identities", timestamps: true });

  const CrmConversation = sequelize.define("CrmConversation", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, connectionId: { type: DataTypes.UUID, allowNull: false },
    identityId: DataTypes.UUID, contactId: DataTypes.UUID, externalThreadId: { type: DataTypes.STRING(255), allowNull: false },
    channel: { type: DataTypes.STRING(40), allowNull: false }, status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "open" },
    priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "normal" }, assignedTeamId: DataTypes.STRING(120),
    assignedUserId: DataTypes.INTEGER, subject: DataTypes.STRING(500), lastMessageId: DataTypes.UUID,
    lastMessageDirection: DataTypes.STRING(20), lastMessageAt: DataTypes.DATE, lastInboundAt: DataTypes.DATE,
    lastOutboundAt: DataTypes.DATE, unreadCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    dueAt: DataTypes.DATE, snoozedUntil: DataTypes.DATE, replyWindowClosesAt: DataTypes.DATE, closedAt: DataTypes.DATE,
    metadataSafe: jsonObject(), version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  }, { tableName: "crm_conversations", timestamps: true, version: "version" });

  const CrmConversationMessage = sequelize.define("CrmConversationMessage", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, conversationId: { type: DataTypes.UUID, allowNull: false },
    connectionId: { type: DataTypes.UUID, allowNull: false }, senderIdentityId: DataTypes.UUID,
    direction: { type: DataTypes.STRING(20), allowNull: false }, messageType: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "text" },
    textBody: DataTypes.TEXT, attachments: jsonArray(), providerMessageId: DataTypes.STRING(255), idempotencyKey: DataTypes.STRING(255),
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "received" }, failureCode: DataTypes.STRING(100),
    failureMessageSafe: DataTypes.TEXT, sentByUserId: DataTypes.INTEGER,
    occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, providerCreatedAt: DataTypes.DATE,
    metadataSafe: jsonObject(),
  }, { tableName: "crm_conversation_messages", timestamps: true });

  const CrmConversationMessageEvent = sequelize.define("CrmConversationMessageEvent", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, messageId: { type: DataTypes.UUID, allowNull: false },
    eventType: { type: DataTypes.STRING(40), allowNull: false }, providerEventId: DataTypes.STRING(255),
    occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, metadataSafe: jsonObject(),
  }, { tableName: "crm_conversation_message_events", timestamps: true });

  const CrmConversationAssignment = sequelize.define("CrmConversationAssignment", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, conversationId: { type: DataTypes.UUID, allowNull: false },
    fromTeamId: DataTypes.STRING(120), fromUserId: DataTypes.INTEGER, toTeamId: DataTypes.STRING(120), toUserId: DataTypes.INTEGER,
    assignedByUserId: DataTypes.INTEGER, reason: DataTypes.STRING(500),
  }, { tableName: "crm_conversation_assignments", timestamps: true });

  const CrmConversationTag = sequelize.define("CrmConversationTag", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, conversationId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false }, normalizedName: { type: DataTypes.STRING(100), allowNull: false },
    addedByUserId: DataTypes.INTEGER,
  }, { tableName: "crm_conversation_tags", timestamps: true });

  const CrmConversationWebhookEvent = sequelize.define("CrmConversationWebhookEvent", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, connectionId: { type: DataTypes.UUID, allowNull: false },
    provider: { type: DataTypes.STRING(60), allowNull: false }, providerEventId: { type: DataTypes.STRING(255), allowNull: false },
    eventType: DataTypes.STRING(80), payloadHash: { type: DataTypes.STRING(128), allowNull: false }, payloadSafe: jsonObject(),
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "pending" },
    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, nextAttemptAt: DataTypes.DATE,
    processedAt: DataTypes.DATE, lastErrorCode: DataTypes.STRING(100), lastErrorMessageSafe: DataTypes.TEXT,
  }, { tableName: "crm_conversation_webhook_events", timestamps: true });

  const CrmConversationOutbox = sequelize.define("CrmConversationOutbox", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, aggregateType: { type: DataTypes.STRING(60), allowNull: false },
    aggregateId: { type: DataTypes.UUID, allowNull: false }, eventType: { type: DataTypes.STRING(80), allowNull: false }, payloadSafe: jsonObject(),
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "pending" }, attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    availableAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, lockedAt: DataTypes.DATE,
    processedAt: DataTypes.DATE, lastErrorCode: DataTypes.STRING(100), lastErrorMessageSafe: DataTypes.TEXT,
  }, { tableName: "crm_conversation_outbox", timestamps: true });

  const CrmConversationOauthState = sequelize.define("CrmConversationOauthState", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false }, userId: { type: DataTypes.INTEGER, allowNull: false },
    provider: { type: DataTypes.STRING(60), allowNull: false }, stateHash: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "pending" }, encryptedResult: DataTypes.TEXT,
    resultSafe: jsonObject(), expiresAt: { type: DataTypes.DATE, allowNull: false }, consumedAt: DataTypes.DATE,
    lastErrorCode: DataTypes.STRING(100), lastErrorMessageSafe: DataTypes.TEXT,
  }, { tableName: "crm_conversation_oauth_states", timestamps: true });

  const CrmConversationWorkspaceConfig = sequelize.define("CrmConversationWorkspaceConfig", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    routing: jsonObject(), preferences: jsonObject(), updatedByUserId: DataTypes.INTEGER,
  }, { tableName: "crm_conversation_workspace_configs", timestamps: true });

  const CrmConversationRoutingRule = sequelize.define("CrmConversationRoutingRule", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false },
    condition: { type: DataTypes.STRING(500), allowNull: false }, destination: { type: DataTypes.STRING(120), allowNull: false },
    priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "normal" },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, createdByUserId: DataTypes.INTEGER,
  }, { tableName: "crm_conversation_routing_rules", timestamps: true });

  const CrmConversationSavedReply = sequelize.define("CrmConversationSavedReply", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(180), allowNull: false }, shortcut: { type: DataTypes.STRING(80), allowNull: false },
    category: { type: DataTypes.STRING(80), allowNull: false, defaultValue: "General" }, body: { type: DataTypes.TEXT, allowNull: false },
    usageCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, createdByUserId: DataTypes.INTEGER,
  }, { tableName: "crm_conversation_saved_replies", timestamps: true });

  const CrmConversationAutomationRule = sequelize.define("CrmConversationAutomationRule", {
    id: uuid(), locationId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(180), allowNull: false }, trigger: { type: DataTypes.STRING(255), allowNull: false },
    action: { type: DataTypes.STRING(255), allowNull: false }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    runCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, lastRunAt: DataTypes.DATE,
    createdByUserId: DataTypes.INTEGER,
  }, { tableName: "crm_conversation_automation_rules", timestamps: true });

  return { CrmConversationChannelConnection, CrmConversationIdentity, CrmConversation, CrmConversationMessage,
    CrmConversationMessageEvent, CrmConversationAssignment, CrmConversationTag, CrmConversationWebhookEvent,
    CrmConversationOutbox, CrmConversationOauthState, CrmConversationWorkspaceConfig,
    CrmConversationRoutingRule, CrmConversationSavedReply, CrmConversationAutomationRule };
}

module.exports = defineConversationModels;
