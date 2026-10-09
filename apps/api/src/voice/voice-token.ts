import {
  VOICE_TOKEN_AUDIENCE,
  VOICE_TOKEN_ISSUER,
  type VoiceTokenClaims,
} from '@frequencia/shared';
import { SignJWT } from 'jose';

export interface VoiceTokenOptions {
  secret: string;
  ttlSeconds: number;
}

/** Signs the short-lived token the media service requires to let a user into a voice channel. */
export function signVoiceToken(
  claims: VoiceTokenClaims,
  { secret, ttlSeconds }: VoiceTokenOptions,
): Promise<string> {
  const { sub, ...rest } = claims;
  return new SignJWT(rest)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience(VOICE_TOKEN_AUDIENCE)
    .setIssuer(VOICE_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}
