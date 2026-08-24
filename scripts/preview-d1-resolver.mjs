export function resolvePreviewDatabaseId(json, databaseName) {
  const databases = JSON.parse(json);
  if (!Array.isArray(databases)) {
    throw new TypeError("D1 database list must be a JSON array");
  }

  const matches = databases.filter(
    (database) => database?.name === databaseName || database?.database_name === databaseName,
  );
  if (matches.length > 1) {
    throw new Error(`multiple databases named ${databaseName}`);
  }
  if (matches.length === 0) {
    return undefined;
  }

  const databaseId = matches[0].uuid ?? matches[0].database_id;
  if (typeof databaseId !== "string" || databaseId.trim() === "") {
    throw new Error(`database ${databaseName} has no UUID`);
  }
  return databaseId;
}
