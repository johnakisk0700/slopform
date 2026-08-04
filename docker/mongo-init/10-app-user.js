const databaseName = process.env.MONGO_INITDB_DATABASE;
const applicationUser = process.env.MONGODB_APP_USER;
const passwordFile = process.env.MONGODB_APP_PASSWORD_FILE;
const applicationPassword =
  process.env.MONGODB_APP_PASSWORD ??
  (passwordFile ? fs.readFileSync(passwordFile, "utf8").trim() : undefined);

if (
  !databaseName ||
  !/^[A-Za-z0-9_-]{1,63}$/u.test(databaseName) ||
  !applicationUser ||
  !/^[A-Za-z0-9._-]{1,64}$/u.test(applicationUser) ||
  !applicationPassword ||
  !/^[A-Za-z0-9._~-]{16,128}$/u.test(applicationPassword)
) {
  throw new Error("MongoDB application-user configuration is invalid");
}

const applicationDatabase = db.getSiblingDB(databaseName);

applicationDatabase.createUser({
  user: applicationUser,
  pwd: applicationPassword,
  roles: [{ role: "readWrite", db: databaseName }],
});

applicationDatabase.createCollection("conversation_threads");
applicationDatabase.runCommand({
  createIndexes: "conversation_threads",
  indexes: [
    {
      name: "conversation_owner_purpose_updated_idx",
      key: {
        "owner.type": 1,
        "owner.id": 1,
        purpose: 1,
        updatedAt: -1,
      },
    },
    {
      name: "conversation_purpose_state_updated_idx",
      key: { purpose: 1, state: 1, updatedAt: 1 },
    },
    {
      name: "feedback_conversation_open_phone_unique_idx",
      key: { phoneAtLaunch: 1 },
      unique: true,
      partialFilterExpression: {
        purpose: "post_event_feedback",
        "lifecycle.state": "open",
      },
    },
    {
      name: "feedback_conversation_campaign_updated_idx",
      key: { campaignId: 1, updatedAt: -1 },
    },
    {
      name: "feedback_conversation_work_due_idx",
      key: { "work.nextActionAt": 1, _id: 1 },
      partialFilterExpression: {
        purpose: "post_event_feedback",
        "work.nextActionAt": { $type: "date" },
      },
    },
  ],
});
