import {
  VOICE_TOKEN_AUDIENCE,
  VOICE_TOKEN_ISSUER,
  voiceTokenClaimsSchema,
  type VoiceTokenClaims,
} from '@frequencia/shared';
import { jwtVerify } from 'jose';

/** Verifies a voice token issued by the API. Returns `null` for anything invalid or expired. */
export async function verifyVoiceToken(
  token: string,
  sharedSecret: string,
): Promise<VoiceTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(sharedSecret), {
      algorithms: ['HS256'],
      audience: VOICE_TOKEN_AUDIENCE,
      issuer: VOICE_TOKEN_ISSUER,
    });
    const claims = voiceTokenClaimsSchema.safeParse(payload);
    return claims.success ? claims.data : null;
  } catch {
    return null;
  }
}
