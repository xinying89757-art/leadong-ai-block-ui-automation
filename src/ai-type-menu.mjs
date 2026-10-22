export function exactTypeMenuMatches(optionTexts, expectedType) {
  const expected = String(expectedType ?? "").trim();
  return (optionTexts ?? []).flatMap((text, index) =>
    String(text ?? "").trim() === expected ? [index] : []);
}
