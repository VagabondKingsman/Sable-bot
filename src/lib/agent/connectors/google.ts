/** W2b: Google provider + Gmail / Calendar connector definitions (overridable bases for the local mock). */
import type { ConnectorDef, OAuthProvider } from "../oauth/types.ts";

export type GoogleBases = { auth: string; token: string; revoke: string; gmail: string; calendar: string };

export const GOOGLE_BASES: GoogleBases = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me/",
  calendar: "https://www.googleapis.com/calendar/v3/",
};

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
export const GCAL_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"];

export function googleDefs(bases: GoogleBases = GOOGLE_BASES): { provider: OAuthProvider; connectors: ConnectorDef[] } {
  return {
    provider: {
      id: "google",
      label: "Google",
      authUrl: bases.auth,
      tokenUrl: bases.token,
      revokeUrl: bases.revoke,
      authParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    connectors: [
      {
        id: "gmail",
        label: "Gmail",
        provider: "google",
        description: "Đọc/tìm thư, nhãn, tạo nháp. Gửi thư luôn cần bạn duyệt.",
        scopes: GMAIL_SCOPES,
        apiBases: [bases.gmail],
      },
      {
        id: "gcal",
        label: "Google Calendar",
        provider: "google",
        description: "Xem lịch, sự kiện, free/busy. Tạo/sửa/xoá sự kiện cần bạn duyệt.",
        scopes: GCAL_SCOPES,
        apiBases: [bases.calendar],
      },
    ],
  };
}
