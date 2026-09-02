export function parseEnvFile(source, allowedNames, parseValue, invalidLine) {
  const values = {};
  for (const [index, line] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    const declaration = (equalsIndex === -1 ? trimmed : trimmed.slice(0, equalsIndex)).trim();
    const name = declaration.replace(/^export\s+/, "").trim();
    if (equalsIndex === -1 || !/^[A-Za-z_]\w*$/.test(name)) {
      const leadingName = name.match(/^[A-Za-z_]\w*/)?.[0];
      if (allowedNames.has(leadingName)) throw invalidLine(lineNumber);
      continue;
    }
    if (!allowedNames.has(name)) continue;
    values[name] = parseValue(trimmed.slice(equalsIndex + 1), lineNumber);
  }
  return values;
}
