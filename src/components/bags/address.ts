const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// ENS-looking: dot-separated labels of letters, digits and hyphens, ending in a letter TLD (name.eth, me.base.eth)
const ENS = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** A trimmed 0x address or a lower-cased ENS name; null when it is neither. */
export function normalizeBagsInput(raw: string): string | null {
  const v = raw.trim();
  if (ADDRESS.test(v)) return v;
  if (ENS.test(v)) return v.toLowerCase();
  return null;
}
