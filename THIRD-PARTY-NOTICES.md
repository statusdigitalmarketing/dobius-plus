# Third-party notices

Dobius+ includes or adapts the following. Each is listed with where it is used and the terms it comes under.

## Happy (slopus/happy)

Parts of `electron/phone-runner-core.mjs` are adapted from Happy (https://github.com/slopus/happy,
`packages/happy-cli/src/claude`): the routing of Claude's tool permission requests (questions and plan approvals always
go to a person, request ids scoped per subagent, the text sent back on a deny), the streaming input queue that keeps a
conversation open between turns, and the `remote_mobile` entrypoint. They were rewritten in JavaScript for Dobius+.
The notice below is also kept at the top of that file and in the bundled phone runner (`dist-phone/phone-runner.mjs`).

```
MIT License

Copyright (c) 2026 Happy Coder Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Claude Agent SDK (@anthropic-ai/claude-agent-sdk)

Bundled into the phone runner (`dist-phone/phone-runner.mjs`, built by `scripts/build-phone-runner.mjs`) to drive the
`claude` command the person already has installed, with the login that command already uses. Dobius+ offers no
sign-in of its own. The SDK's own license:

```
© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here:
https://code.claude.com/docs/en/legal-and-compliance.
```
