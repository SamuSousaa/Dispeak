import {
  API_PREFIX,
  LAB_VOICE_TOKEN_PATH,
  voiceTokenResponseSchema,
  type LabVoiceTokenRequest,
  type VoiceTokenResponse,
} from '@frequencia/shared';

const CLIENT_ID_KEY = 'lab.clientId';

/** Stable id for this tab, so a reconnect replaces the previous voice session. */
export function labClientId(): string {
  let id = sessionStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export async function fetchLabVoiceToken(
  request: Omit<LabVoiceTokenRequest, 'clientId'>,
): Promise<VoiceTokenResponse> {
  const response = await fetch(`${API_PREFIX}${LAB_VOICE_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, clientId: labClientId() }),
  });
  if (!response.ok) throw new Error(`voice token request failed: ${response.status}`);
  return voiceTokenResponseSchema.parse(await response.json());
}
