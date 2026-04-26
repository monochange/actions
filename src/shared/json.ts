export function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function extractJsonBlock(text: string): string | undefined {
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  /* eslint-disable-next-line regexp/no-useless-escape */
  const jsonMatch = trimmed.match(/```(?:json)?\s*({[\s\S]*?}|\[[\s\S]*?])\s*```/);

  if (jsonMatch?.[1]) {
    return jsonMatch[1].trim();
  }

  const inlineMatch = trimmed.match(/({[\s\S]*?}|\[[\s\S]*?])/);

  if (inlineMatch?.[1]) {
    return inlineMatch[1].trim();
  }

  return undefined;
}

export function parseMixedOutput<T>(text: string): T | undefined {
  const block = extractJsonBlock(text);

  if (block) {
    return safeJsonParse<T>(block);
  }

  return safeJsonParse<T>(text);
}
