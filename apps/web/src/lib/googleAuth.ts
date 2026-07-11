import { OAuth2Client } from "google-auth-library";
import { requireEnv } from "@shorts/shared";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export function googleRedirectUri(): string {
  return `${requireEnv("APP_URL").replace(/\/$/, "")}/api/auth/google/callback`;
}

export function getOAuthClient(): OAuth2Client {
  return new OAuth2Client(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    googleRedirectUri()
  );
}
