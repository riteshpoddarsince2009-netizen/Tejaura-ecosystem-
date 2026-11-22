const REDACTION_TOKEN = '[REDACTED]';

/**
 * Removes known secret values from free-form text before it reaches logs,
 * error responses, or audit metadata.
 */
export function redactKnownSecrets(
  text: string,
  knownSecrets: readonly string[],
): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  let redacted = text;
  const unique = [...new Set(knownSecrets)]
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const secret of unique) {
    redacted = redacted.split(secret).join(REDACTION_TOKEN);
  }

  return redacted;
}
