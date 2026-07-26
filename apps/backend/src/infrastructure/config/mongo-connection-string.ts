import { MongoClient } from "mongodb";
import type { RefinementCtx } from "zod";

export interface ParsedMongoConnectionString {
  readonly protocol: "mongodb:" | "mongodb+srv:";
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly database: string | undefined;
  readonly hostnames: readonly string[];
  readonly searchParams: URLSearchParams;
}

const mongoOption = (
  searchParams: URLSearchParams,
  name: string,
): string | undefined => {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of searchParams) {
    if (key.toLowerCase() === normalizedName) {
      return value.toLowerCase();
    }
  }
  return undefined;
};
export const parseMongoConnectionString = (
  value: string,
): ParsedMongoConnectionString | undefined => {
  const protocol = value.startsWith("mongodb://")
    ? ("mongodb:" as const)
    : value.startsWith("mongodb+srv://")
      ? ("mongodb+srv:" as const)
      : undefined;
  if (!protocol || value.includes("#")) {
    return undefined;
  }

  try {
    // The driver's parser supports replica-set seed lists, unlike WHATWG URL.
    new MongoClient(value);
  } catch {
    return undefined;
  }

  const schemeLength =
    protocol === "mongodb:" ? "mongodb://".length : "mongodb+srv://".length;
  const remainder = value.slice(schemeLength);
  const queryStart = remainder.indexOf("?");
  const addressAndPath =
    queryStart === -1 ? remainder : remainder.slice(0, queryStart);
  const query = queryStart === -1 ? "" : remainder.slice(queryStart + 1);
  const pathStart = addressAndPath.indexOf("/");
  const authority =
    pathStart === -1 ? addressAndPath : addressAndPath.slice(0, pathStart);
  const database =
    pathStart === -1
      ? undefined
      : addressAndPath.slice(pathStart + 1) || undefined;
  const credentialEnd = authority.lastIndexOf("@");
  const credentials =
    credentialEnd === -1 ? undefined : authority.slice(0, credentialEnd);
  const seeds =
    credentialEnd === -1 ? authority : authority.slice(credentialEnd + 1);
  const passwordStart = credentials?.indexOf(":") ?? -1;
  const username =
    credentials === undefined
      ? undefined
      : passwordStart === -1
        ? credentials
        : credentials.slice(0, passwordStart);
  const password =
    credentials === undefined || passwordStart === -1
      ? undefined
      : credentials.slice(passwordStart + 1);

  return {
    protocol,
    username: username || undefined,
    password: password || undefined,
    database,
    hostnames: seeds.split(",").map(mongoSeedHostname),
    searchParams: new URLSearchParams(query),
  };
};
const mongoSeedHostname = (seed: string): string => {
  if (seed.startsWith("[")) {
    const bracket = seed.indexOf("]");
    return seed.slice(1, bracket).toLowerCase();
  }
  const portSeparator = seed.lastIndexOf(":");
  return (portSeparator === -1 ? seed : seed.slice(0, portSeparator))
    .toLowerCase()
    .trim();
};

export function addProductionMongoIssues(
  mongo: ParsedMongoConnectionString,
  context: RefinementCtx,
): void {
  if (!mongo.username || !mongo.password) {
    context.addIssue({
      code: "custom",
      message: "Production MongoDB requires authenticated credentials",
      path: ["MONGODB_URI"],
    });
  }

  const unsafeOptions = [
    "tlsInsecure",
    "tlsAllowInvalidCertificates",
    "tlsAllowInvalidHostnames",
  ];
  if (
    unsafeOptions.some(
      (option) => mongoOption(mongo.searchParams, option) === "true",
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Production MongoDB must not disable TLS certificate verification",
      path: ["MONGODB_URI"],
    });
  }

  const tls =
    mongoOption(mongo.searchParams, "tls") ??
    mongoOption(mongo.searchParams, "ssl");
  const internalComposeMongo =
    mongo.hostnames.length === 1 && mongo.hostnames[0] === "mongo";
  if (
    (mongo.protocol === "mongodb+srv:" && tls === "false") ||
    (mongo.protocol === "mongodb:" && !internalComposeMongo && tls !== "true")
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Production MongoDB outside the internal mongo service requires TLS",
      path: ["MONGODB_URI"],
    });
  }
}
