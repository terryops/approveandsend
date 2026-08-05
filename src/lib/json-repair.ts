/**
 * Models are asked for JSON and mostly comply, but they wrap it in markdown
 * fences and they forget to escape quotes inside string values, e.g.
 *   "summary": "the file shows as "ineligible""
 * Rather than retrying the whole (slow, expensive) call, repair what we got.
 */

/** Escape double quotes that appear inside JSON string values. */
export function repairJson(text: string): string {
  let result = '';
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;

    // Escape sequences pass through untouched.
    if (char === '\\' && inString) {
      result += char + (text[i + 1] ?? '');
      i += 2;
      continue;
    }

    if (char !== '"') {
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      inString = true;
      result += char;
      i++;
      continue;
    }

    // Ambiguous: a closing quote, or an unescaped quote inside the value?
    // Only , : } ] or EOF may legally follow a closing quote.
    let lookAhead = i + 1;
    while (lookAhead < text.length && /\s/.test(text[lookAhead]!)) lookAhead++;
    const next = text[lookAhead];

    if (next === ',' || next === ':' || next === '}' || next === ']' || lookAhead >= text.length) {
      inString = false;
      result += char;
    } else {
      result += '\\"';
    }
    i++;
  }

  return result;
}

/**
 * Pull a JSON object out of a model response. Tries the plain parse first,
 * then the outermost {...}, then the same with quotes repaired.
 * Returns null rather than throwing — callers decide whether that is fatal.
 */
export function extractJson<T>(response: string): T | null {
  const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  try {
    return JSON.parse(cleaned.trim()) as T;
  } catch {
    // fall through
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[extractJson] no JSON object in response:', response.slice(0, 300));
    return null;
  }

  try {
    return JSON.parse(match[0]) as T;
  } catch {
    // fall through to repair
  }

  try {
    return JSON.parse(repairJson(match[0])) as T;
  } catch (e) {
    console.error('[extractJson] unparseable after repair:', e);
    console.error('[extractJson] response was:', response.slice(0, 500));
    return null;
  }
}
