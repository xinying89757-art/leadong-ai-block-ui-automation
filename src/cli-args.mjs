/** Parse positional arguments and both --key value / --key=value options. */
export function parseCliArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      options[key] = inline;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[key] = argv[++index];
    } else {
      options[key] = true;
    }
  }
  return options;
}
