/*
 * Batch argument escaping adapted from execa 10.2.1's command-file.js, which
 * follows Rust's append_bat_arg (the CVE-2024-24576 fix).
 *
 * MIT License
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

// cmd.exe has no safe argument representation for CR/LF.
function assertNoLineBreak(value) {
  if (/[\r\n]/.test(value)) {
    throw new TypeError('Windows launch commands and arguments cannot contain a line break');
  }
}

function quoteWindowsArgument(value) {
  const argument = String(value);
  assertNoLineBreak(argument);
  const escaped = argument
    .replace(/\\+/g, (backslashes, offset) => {
      const next = argument[offset + backslashes.length];
      return next === '"' || next === undefined ? backslashes.repeat(2) : backslashes;
    })
    // Backslash-quote would unbalance cmd's quotes, exposing shell operators.
    .replace(/"/g, '""')
    // Expand an empty substring after each percent sign, preserving it literally.
    .replace(/%/g, '%%cd:~,%');
  return `"${escaped}"`;
}

function buildWindowsCommand(command, args) {
  assertNoLineBreak(command);
  // launchCommand is trusted user configuration (and can include fixed flags).
  // Dynamic CLI values must remain arguments, including through npm's %* shim.
  return `"${[command, ...args.map(quoteWindowsArgument)].join(' ')}"`;
}

module.exports = { buildWindowsCommand };
