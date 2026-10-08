require("dotenv").config();

if (process.env.NODE_ENV === "production" && !process.env.MOVIRA_CRM_DATABASE_URL) {
  throw new Error("MOVIRA_CRM_DATABASE_URL is required for Movira CRM production migrations");
}

const base = {
  dialect: "postgres",
  logging: false,
  migrationStorage: "sequelize",
  migrationStorageTableName: "SequelizeMetaCrm",
  migrationStorageTableSchema: "public",
  seederStorage: "sequelize",
  seederStorageTableName: "SequelizeDataCrm",
  seederStorageTableSchema: "public",
};

function crmSchema() {
  const schema = process.env.CRM_DB_SCHEMA || "crm";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error("CRM_DB_SCHEMA must be a valid PostgreSQL identifier");
  }
  return schema;
}

function dialectOptions() {
  return {
    options: `-c search_path=${crmSchema()},public`,
  };
}

function shouldUseSsl() {
  const value = String(process.env.MOVIRA_CRM_DB_SSL || "").toLowerCase();
  if (["false", "0", "no", "disable"].includes(value)) return false;
  if (["true", "1", "yes", "require"].includes(value)) return true;
  return process.env.NODE_ENV === "production";
}

function sslOptions() {
  return {
    dialectOptions: {
      ...dialectOptions(),
      ...(shouldUseSsl()
        ? {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
          }
        : {}),
    },
  };
}

function fromUrl() {
  return {
    use_env_variable: "MOVIRA_CRM_DATABASE_URL",
    ...base,
    schema: crmSchema(),
    define: {
      schema: crmSchema(),
    },
    ...sslOptions(),
  };
}

function fromParts() {
  return {
    username: process.env.MOVIRA_CRM_DB_USERNAME || "your_db_username",
    password: process.env.MOVIRA_CRM_DB_PASSWORD || "your_db_password",
    database: process.env.MOVIRA_CRM_DB_NAME || "movira_core",
    host: process.env.MOVIRA_CRM_DB_HOST || "127.0.0.1",
    port: Number(process.env.MOVIRA_CRM_DB_PORT || 5432),
    ...base,
    schema: crmSchema(),
    define: {
      schema: crmSchema(),
    },
    ...sslOptions(),
  };
}

function hasDatabaseUrl() {
  return Boolean(process.env.MOVIRA_CRM_DATABASE_URL);
}

module.exports = {
  development: hasDatabaseUrl() ? fromUrl() : fromParts(),
  test: hasDatabaseUrl() ? fromUrl() : fromParts(),
  production: hasDatabaseUrl() ? fromUrl() : fromParts(),
};
