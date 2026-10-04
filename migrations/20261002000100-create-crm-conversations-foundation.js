"use strict";

function crmSchema() {
  const schema = process.env.CRM_DB_SCHEMA || "crm";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("CRM_DB_SCHEMA must be a valid PostgreSQL identifier");
  return schema;
}

const table = (schema, tableName) => ({ tableName, schema });
const timestamps = (Sequelize) => ({
  createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
  updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
});

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const schema = crmSchema();

    await queryInterface.createTable(table(schema, "crm_conversation_channel_connections"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      channel: { type: Sequelize.STRING(40), allowNull: false },
      provider: { type: Sequelize.STRING(60), allowNull: false },
      externalAccountId: { type: Sequelize.STRING(255), allowNull: false },
      displayName: { type: Sequelize.STRING(255), allowNull: true },
      status: { type: Sequelize.STRING(40), allowNull: false, defaultValue: "connecting" },
      encryptedCredentials: { type: Sequelize.TEXT, allowNull: true },
      grantedScopes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      capabilities: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      tokenExpiresAt: { type: Sequelize.DATE, allowNull: true },
      lastWebhookAt: { type: Sequelize.DATE, allowNull: true },
      lastHealthCheckAt: { type: Sequelize.DATE, allowNull: true },
      lastErrorCode: { type: Sequelize.STRING(100), allowNull: true },
      lastErrorMessageSafe: { type: Sequelize.TEXT, allowNull: true },
      connectedByUserId: { type: Sequelize.INTEGER, allowNull: true },
      disconnectedAt: { type: Sequelize.DATE, allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      ...timestamps(Sequelize),
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_channel_connections"), {
      fields: ["locationId", "channel", "provider", "externalAccountId"], type: "unique", name: "crm_conv_connections_location_account_uk",
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_channel_connections"), {
      fields: ["channel", "provider", "externalAccountId"], type: "unique", name: "crm_conv_connections_provider_account_uk",
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_channel_connections"), ["locationId", "status"], { name: "crm_conv_connections_location_status_idx" });

    await queryInterface.createTable(table(schema, "crm_conversation_identities"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      connectionId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversation_channel_connections"), key: "id" }, onDelete: "CASCADE" },
      contactId: { type: Sequelize.UUID, allowNull: true, references: { model: table(schema, "crm_contacts"), key: "id" }, onDelete: "SET NULL" },
      channel: { type: Sequelize.STRING(40), allowNull: false },
      externalUserId: { type: Sequelize.STRING(255), allowNull: false },
      handle: { type: Sequelize.STRING(255), allowNull: true },
      displayName: { type: Sequelize.STRING(255), allowNull: true },
      avatarUrlCached: { type: Sequelize.TEXT, allowNull: true },
      profileMetadataSafe: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      matchMethod: { type: Sequelize.STRING(40), allowNull: true },
      matchConfidence: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      linkedByUserId: { type: Sequelize.INTEGER, allowNull: true },
      linkedAt: { type: Sequelize.DATE, allowNull: true },
      unlinkedAt: { type: Sequelize.DATE, allowNull: true },
      lastSeenAt: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_identities"), {
      fields: ["connectionId", "externalUserId"], type: "unique", name: "crm_conv_identities_connection_user_uk",
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_identities"), ["locationId", "contactId"], { name: "crm_conv_identities_location_contact_idx" });

    await queryInterface.createTable(table(schema, "crm_conversations"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      connectionId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversation_channel_connections"), key: "id" }, onDelete: "RESTRICT" },
      identityId: { type: Sequelize.UUID, allowNull: true, references: { model: table(schema, "crm_conversation_identities"), key: "id" }, onDelete: "SET NULL" },
      contactId: { type: Sequelize.UUID, allowNull: true, references: { model: table(schema, "crm_contacts"), key: "id" }, onDelete: "SET NULL" },
      externalThreadId: { type: Sequelize.STRING(255), allowNull: false },
      channel: { type: Sequelize.STRING(40), allowNull: false },
      status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "open" },
      priority: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "normal" },
      assignedTeamId: { type: Sequelize.STRING(120), allowNull: true },
      assignedUserId: { type: Sequelize.INTEGER, allowNull: true },
      subject: { type: Sequelize.STRING(500), allowNull: true },
      lastMessageId: { type: Sequelize.UUID, allowNull: true },
      lastMessageDirection: { type: Sequelize.STRING(20), allowNull: true },
      lastMessageAt: { type: Sequelize.DATE, allowNull: true },
      lastInboundAt: { type: Sequelize.DATE, allowNull: true },
      lastOutboundAt: { type: Sequelize.DATE, allowNull: true },
      unreadCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      dueAt: { type: Sequelize.DATE, allowNull: true },
      snoozedUntil: { type: Sequelize.DATE, allowNull: true },
      replyWindowClosesAt: { type: Sequelize.DATE, allowNull: true },
      closedAt: { type: Sequelize.DATE, allowNull: true },
      metadataSafe: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      ...timestamps(Sequelize),
    });
    await queryInterface.addConstraint(table(schema, "crm_conversations"), {
      fields: ["connectionId", "externalThreadId"], type: "unique", name: "crm_conversations_connection_thread_uk",
    });
    await queryInterface.addIndex(table(schema, "crm_conversations"), ["locationId", "status", "lastMessageAt"], { name: "crm_conversations_inbox_idx" });
    await queryInterface.addIndex(table(schema, "crm_conversations"), ["locationId", "assignedUserId", "status"], { name: "crm_conversations_assignee_idx" });

    await queryInterface.createTable(table(schema, "crm_conversation_messages"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      conversationId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversations"), key: "id" }, onDelete: "CASCADE" },
      connectionId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversation_channel_connections"), key: "id" }, onDelete: "RESTRICT" },
      senderIdentityId: { type: Sequelize.UUID, allowNull: true, references: { model: table(schema, "crm_conversation_identities"), key: "id" }, onDelete: "SET NULL" },
      direction: { type: Sequelize.STRING(20), allowNull: false },
      messageType: { type: Sequelize.STRING(40), allowNull: false, defaultValue: "text" },
      textBody: { type: Sequelize.TEXT, allowNull: true },
      attachments: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      providerMessageId: { type: Sequelize.STRING(255), allowNull: true },
      idempotencyKey: { type: Sequelize.STRING(255), allowNull: true },
      status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "received" },
      failureCode: { type: Sequelize.STRING(100), allowNull: true },
      failureMessageSafe: { type: Sequelize.TEXT, allowNull: true },
      sentByUserId: { type: Sequelize.INTEGER, allowNull: true },
      occurredAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      providerCreatedAt: { type: Sequelize.DATE, allowNull: true },
      metadataSafe: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      ...timestamps(Sequelize),
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_messages"), {
      fields: ["connectionId", "providerMessageId"], type: "unique", name: "crm_conv_messages_connection_provider_message_uk",
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_messages"), {
      fields: ["locationId", "idempotencyKey"], type: "unique", name: "crm_conv_messages_location_idempotency_uk",
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_messages"), ["conversationId", "occurredAt"], { name: "crm_conv_messages_conversation_time_idx" });

    await queryInterface.createTable(table(schema, "crm_conversation_message_events"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      messageId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversation_messages"), key: "id" }, onDelete: "CASCADE" },
      eventType: { type: Sequelize.STRING(40), allowNull: false },
      providerEventId: { type: Sequelize.STRING(255), allowNull: true },
      occurredAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      metadataSafe: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_message_events"), ["messageId", "occurredAt"], { name: "crm_conv_message_events_message_time_idx" });

    await queryInterface.createTable(table(schema, "crm_conversation_assignments"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      conversationId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversations"), key: "id" }, onDelete: "CASCADE" },
      fromTeamId: { type: Sequelize.STRING(120), allowNull: true },
      fromUserId: { type: Sequelize.INTEGER, allowNull: true },
      toTeamId: { type: Sequelize.STRING(120), allowNull: true },
      toUserId: { type: Sequelize.INTEGER, allowNull: true },
      assignedByUserId: { type: Sequelize.INTEGER, allowNull: true },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_assignments"), ["conversationId", "createdAt"], { name: "crm_conv_assignments_conversation_time_idx" });

    await queryInterface.createTable(table(schema, "crm_conversation_tags"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      conversationId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversations"), key: "id" }, onDelete: "CASCADE" },
      name: { type: Sequelize.STRING(100), allowNull: false },
      normalizedName: { type: Sequelize.STRING(100), allowNull: false },
      addedByUserId: { type: Sequelize.INTEGER, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_tags"), {
      fields: ["conversationId", "normalizedName"], type: "unique", name: "crm_conv_tags_conversation_name_uk",
    });

    await queryInterface.createTable(table(schema, "crm_conversation_webhook_events"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      connectionId: { type: Sequelize.UUID, allowNull: false, references: { model: table(schema, "crm_conversation_channel_connections"), key: "id" }, onDelete: "CASCADE" },
      provider: { type: Sequelize.STRING(60), allowNull: false },
      providerEventId: { type: Sequelize.STRING(255), allowNull: false },
      eventType: { type: Sequelize.STRING(80), allowNull: true },
      payloadHash: { type: Sequelize.STRING(128), allowNull: false },
      payloadSafe: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "pending" },
      attemptCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      nextAttemptAt: { type: Sequelize.DATE, allowNull: true },
      processedAt: { type: Sequelize.DATE, allowNull: true },
      lastErrorCode: { type: Sequelize.STRING(100), allowNull: true },
      lastErrorMessageSafe: { type: Sequelize.TEXT, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_webhook_events"), {
      fields: ["connectionId", "providerEventId"], type: "unique", name: "crm_conv_webhook_connection_event_uk",
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_webhook_events"), ["status", "nextAttemptAt"], { name: "crm_conv_webhook_processing_idx" });

    await queryInterface.createTable(table(schema, "crm_conversation_outbox"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      aggregateType: { type: Sequelize.STRING(60), allowNull: false },
      aggregateId: { type: Sequelize.UUID, allowNull: false },
      eventType: { type: Sequelize.STRING(80), allowNull: false },
      payloadSafe: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "pending" },
      attemptCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      availableAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      lockedAt: { type: Sequelize.DATE, allowNull: true },
      processedAt: { type: Sequelize.DATE, allowNull: true },
      lastErrorCode: { type: Sequelize.STRING(100), allowNull: true },
      lastErrorMessageSafe: { type: Sequelize.TEXT, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_outbox"), ["status", "availableAt"], { name: "crm_conv_outbox_processing_idx" });
    await queryInterface.addIndex(table(schema, "crm_conversation_outbox"), ["eventType", "status", "availableAt"], { name: "crm_conv_outbox_event_processing_idx" });
    await queryInterface.addIndex(table(schema, "crm_conversation_outbox"), ["locationId", "createdAt", "id"], { name: "crm_conv_outbox_location_feed_idx" });
  },

  down: async (queryInterface) => {
    const schema = crmSchema();
    for (const name of [
      "crm_conversation_outbox", "crm_conversation_webhook_events", "crm_conversation_tags",
      "crm_conversation_assignments", "crm_conversation_message_events", "crm_conversation_messages",
      "crm_conversations", "crm_conversation_identities", "crm_conversation_channel_connections",
    ]) await queryInterface.dropTable(table(schema, name));
  },
};
