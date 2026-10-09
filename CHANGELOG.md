# Changelog

## [0.32.0](https://github.com/Gitlawb/openclaude/compare/v0.31.0...v0.32.0) (2026-09-29)


### Features

* **gateway:** add API Route hybrid gateway ([#2225](https://github.com/Gitlawb/openclaude/issues/2225)) ([9a2910d](https://github.com/Gitlawb/openclaude/commit/9a2910da236395d259c72c3b4ddf92278625a6c1))

## [0.31.0](https://github.com/Gitlawb/openclaude/compare/v0.30.0...v0.31.0) (2026-09-22)


### Features

* **launcher:** support --max-old-space-size-percentage ([#2219](https://github.com/Gitlawb/openclaude/issues/2219)) ([055e5d5](https://github.com/Gitlawb/openclaude/commit/055e5d551a615c732597a497c2a176c1fe2a8692))
* **providers:** add Command Code hybrid gateway ([#2196](https://github.com/Gitlawb/openclaude/issues/2196)) ([5b9daef](https://github.com/Gitlawb/openclaude/commit/5b9daef6052128c6236e02f9ba45e382491e78f7))
* **query:** configure idle timeout ([#2233](https://github.com/Gitlawb/openclaude/issues/2233)) ([876fb79](https://github.com/Gitlawb/openclaude/commit/876fb7924a35d6b38d0d53eacf185900e2fb7387))
* **skills:** add verify for revocations and eyebrow drift checks ([#2215](https://github.com/Gitlawb/openclaude/issues/2215)) ([eb3c590](https://github.com/Gitlawb/openclaude/commit/eb3c5902eb742322b437d33307590bdc852d4668))
* **skills:** enforce registry revocations.json on install ([#2187](https://github.com/Gitlawb/openclaude/issues/2187)) ([0ea8eef](https://github.com/Gitlawb/openclaude/commit/0ea8eefbd0d48735ddb9e6b8c9e7ee6957dc9b98))
* **web-search:** add Ollama backend ([#2234](https://github.com/Gitlawb/openclaude/issues/2234)) ([70d97fd](https://github.com/Gitlawb/openclaude/commit/70d97fd13772f080f0e9a530d5860874215f9783))
* **zai:** add GLM-5.3-Flash Coding Plan support ([#2185](https://github.com/Gitlawb/openclaude/issues/2185)) ([aceacf0](https://github.com/Gitlawb/openclaude/commit/aceacf0e590a7d84447a8c44f3aa61eba781a542))


### Bug Fixes

* **agent:** forward subagent permission prompts to parent session ([#2235](https://github.com/Gitlawb/openclaude/issues/2235)) ([a07b06c](https://github.com/Gitlawb/openclaude/commit/a07b06cee6af87723c6fba131bf1d9b0680e7e0d))
* **api:** validate API_TIMEOUT_MS in the native Anthropic clients ([#2169](https://github.com/Gitlawb/openclaude/issues/2169)) ([35d7edc](https://github.com/Gitlawb/openclaude/commit/35d7edc2f6548c9c4608a43eabce3ea6cfb14cae))
* **bg:** clean up old completed session artifacts ([#2167](https://github.com/Gitlawb/openclaude/issues/2167)) ([70fe2de](https://github.com/Gitlawb/openclaude/commit/70fe2de2f838857dfc0500974542f2e05863cb23))
* **chrome:** launch the packaged CLI entrypoint in npm installs ([#2146](https://github.com/Gitlawb/openclaude/issues/2146)) ([bfb44ff](https://github.com/Gitlawb/openclaude/commit/bfb44ffa817a2318b319b852106497bfbde2deb2))
* **ci:** restore main validation ([#2236](https://github.com/Gitlawb/openclaude/issues/2236)) ([5fb5abb](https://github.com/Gitlawb/openclaude/commit/5fb5abb6f82aa779e4027bf3298c8b52a5041c8b))
* **ctx:** let explicit overrides beat discovered context windows ([#2082](https://github.com/Gitlawb/openclaude/issues/2082)) ([3451187](https://github.com/Gitlawb/openclaude/commit/3451187aedda550a9dd8f0a7660edb0848de7cff)), closes [#2081](https://github.com/Gitlawb/openclaude/issues/2081)
* **frontmatter:** anchor the closing --- to the start of a line ([#2027](https://github.com/Gitlawb/openclaude/issues/2027)) ([cbbe10f](https://github.com/Gitlawb/openclaude/commit/cbbe10ff8a794f4d97c32af9ef25f334b22bb5f5))
* **hooks:** preserve compound Bash commands on Windows ([#2217](https://github.com/Gitlawb/openclaude/issues/2217)) ([0c2043f](https://github.com/Gitlawb/openclaude/commit/0c2043f05e70bb6cdd673423fa2555a6d1c272bf))
* identify OpenCode Go requests ([#2203](https://github.com/Gitlawb/openclaude/issues/2203)) ([3609d75](https://github.com/Gitlawb/openclaude/commit/3609d751c06531873485ae5197737ae85c99b3a7))
* **image:** allow large/metadata-less screenshots through on resize failure ([#1964](https://github.com/Gitlawb/openclaude/issues/1964)) ([#1970](https://github.com/Gitlawb/openclaude/issues/1970)) ([2e687df](https://github.com/Gitlawb/openclaude/commit/2e687df4ec1bf86195abfc37494d18e1da9e04d4))
* **mcp:** resolve server names by own-property, not the prototype chain ([#1983](https://github.com/Gitlawb/openclaude/issues/1983)) ([c3930ca](https://github.com/Gitlawb/openclaude/commit/c3930ca5ad7182057b3bc0bc729d0b56172a9dcd))
* **openai-shim:** request streaming usage from compatible local providers ([#2144](https://github.com/Gitlawb/openclaude/issues/2144)) ([decad0e](https://github.com/Gitlawb/openclaude/commit/decad0e17270c6748b47139b976488b4e60b82bb))
* **plugins:** keep Windows marketplace cache on copy ENOENT ([#2220](https://github.com/Gitlawb/openclaude/issues/2220)) ([e2b021d](https://github.com/Gitlawb/openclaude/commit/e2b021d8bbda66b64cef7dbe1e089fea3eaa563f))
* **profiles:** apply context limit to all profile models ([#2201](https://github.com/Gitlawb/openclaude/issues/2201)) ([0b68e57](https://github.com/Gitlawb/openclaude/commit/0b68e579b9dd44fae984b9ef2b17d03f68befdad))
* **sdk:** preserve async generator session context ([#2204](https://github.com/Gitlawb/openclaude/issues/2204)) ([0abfca3](https://github.com/Gitlawb/openclaude/commit/0abfca30e5a2945678415f5328691584387720fb))
* **xai:** validate OAuth state before settling callbacks ([#2228](https://github.com/Gitlawb/openclaude/issues/2228)) ([d16318a](https://github.com/Gitlawb/openclaude/commit/d16318a47f48a7e6c674b1df9ccb4f3a873886d2))


### Performance Improvements

* **bg:** avoid full scans for exact session IDs ([#2166](https://github.com/Gitlawb/openclaude/issues/2166)) ([55e9b24](https://github.com/Gitlawb/openclaude/commit/55e9b24d9147d059207bd8db6ed54382ba180db9))

## [0.30.0](https://github.com/Gitlawb/openclaude/compare/v0.29.1...v0.30.0) (2026-08-31)


### Features

* **providers:** add focused LLMTR hybrid gateway ([#2150](https://github.com/Gitlawb/openclaude/issues/2150)) ([1e56d4e](https://github.com/Gitlawb/openclaude/commit/1e56d4e7b2fb81dc1ba295ff28858b65889972b2))
* **providers:** live model lists for OpenRouter and OpenGateway ([#2084](https://github.com/Gitlawb/openclaude/issues/2084)) ([bb6d66f](https://github.com/Gitlawb/openclaude/commit/bb6d66faa312e22479be584033a6fbd1ffb9737a))


### Bug Fixes

* **api:** scope Anthropic attribution to compatible request paths ([#2147](https://github.com/Gitlawb/openclaude/issues/2147)) ([30090c7](https://github.com/Gitlawb/openclaude/commit/30090c70e1ea0c1d5b15405aeb2936789d5ebff5))
* **bg:** identify sessions with persisted process markers ([#2163](https://github.com/Gitlawb/openclaude/issues/2163)) ([ca7c3ef](https://github.com/Gitlawb/openclaude/commit/ca7c3efb6e0af40877c42e6cd9ad107dc561435b))
* **effort:** preserve known model exclusions when force-enabled ([#2148](https://github.com/Gitlawb/openclaude/issues/2148)) ([69aca78](https://github.com/Gitlawb/openclaude/commit/69aca780ea8ee4d4a57e3027110d78d07a0c49a6))
* **integrations:** keep managed AIMLAPI attribution over caller headers ([#2179](https://github.com/Gitlawb/openclaude/issues/2179)) ([aaccb57](https://github.com/Gitlawb/openclaude/commit/aaccb57721a362b739d73550b34d5898ee90e791))
* **openai-shim:** drop synthetic tool-results marker and guard echoes ([#2039](https://github.com/Gitlawb/openclaude/issues/2039)) ([#2153](https://github.com/Gitlawb/openclaude/issues/2153)) ([54f963d](https://github.com/Gitlawb/openclaude/commit/54f963d0065a0d5e1544a8ba923602e7057aa9c0))
* **plugins:** anchor marketplace hostPattern against lookalike hosts ([#2177](https://github.com/Gitlawb/openclaude/issues/2177)) ([5f1ab9b](https://github.com/Gitlawb/openclaude/commit/5f1ab9b80ce82f96aea53e1e2c22268e03a1104f))
* **settings:** preserve concurrent updates ([#2137](https://github.com/Gitlawb/openclaude/issues/2137)) ([34536c6](https://github.com/Gitlawb/openclaude/commit/34536c6220171bb96d0225d42a2ab5c1339c14e4))
* **settings:** stop proto-named permission rules from aborting validation ([#2170](https://github.com/Gitlawb/openclaude/issues/2170)) ([8db8830](https://github.com/Gitlawb/openclaude/commit/8db8830666bfa115bf6f9586525fae0e3585bf23))
* **tui:** proper Unicode/IME input handling for composed sequences ([#2018](https://github.com/Gitlawb/openclaude/issues/2018)) ([#2154](https://github.com/Gitlawb/openclaude/issues/2154)) ([e802626](https://github.com/Gitlawb/openclaude/commit/e8026263ca6c2e31fe0444d0b637ec0f069ee556))

## [0.29.1](https://github.com/Gitlawb/openclaude/compare/v0.29.0...v0.29.1) (2026-08-19)


### Performance Improvements

* stop busting the prompt cache and slim per-turn context ([#2142](https://github.com/Gitlawb/openclaude/issues/2142)) ([31ac8a6](https://github.com/Gitlawb/openclaude/commit/31ac8a6ecae593ec08770568aa9ea651595eb162))

## [0.29.0](https://github.com/Gitlawb/openclaude/compare/v0.28.0...v0.29.0) (2026-08-19)


### Features

* **aimlapi:** passwordless onboarding and resumable card top-up (3/3) ([#2032](https://github.com/Gitlawb/openclaude/issues/2032)) ([fb9102c](https://github.com/Gitlawb/openclaude/commit/fb9102c422403e9f65a7cd7a34a96bff679e8ec1))
* **cost:** support exact custom model pricing ([#2131](https://github.com/Gitlawb/openclaude/issues/2131)) ([09eba26](https://github.com/Gitlawb/openclaude/commit/09eba26d303b3458c1922e515fe2965f2f91e71e))
* **gateway:** add Concentrate AI provider with dynamic model discovery ([#2140](https://github.com/Gitlawb/openclaude/issues/2140)) ([084bc53](https://github.com/Gitlawb/openclaude/commit/084bc534639b1d16eca18d067bd7a2cc3634dd96))
* merge knowledge graph + conversation arc into memdir ([#1811](https://github.com/Gitlawb/openclaude/issues/1811)) ([c461a03](https://github.com/Gitlawb/openclaude/commit/c461a0363d172c262cc06bc4d681a78e0adb883d))
* **partners:** add ApiSmart, refresh Novita AI logo ([#2121](https://github.com/Gitlawb/openclaude/issues/2121)) ([575b407](https://github.com/Gitlawb/openclaude/commit/575b407275c96c91984e9c9cea570aa9eabc01cc))
* **partners:** add Concentrate and Exa to partner roster ([#2141](https://github.com/Gitlawb/openclaude/issues/2141)) ([6e35903](https://github.com/Gitlawb/openclaude/commit/6e3590303bcfe7328a148e50a6ea93c4d08f995f))
* **xai:** add Grok 4.6/4.5 to catalog, xAI provider, and gateways ([#2117](https://github.com/Gitlawb/openclaude/issues/2117)) ([7cae408](https://github.com/Gitlawb/openclaude/commit/7cae4089d60c73ed62df3d3f3fad362d5dcc9174))
* **zai:** expand Coding Plan catalog support ([#2127](https://github.com/Gitlawb/openclaude/issues/2127)) ([ea65516](https://github.com/Gitlawb/openclaude/commit/ea655163d3cf4863063fafa538f60f5d1dfe64a3))


### Bug Fixes

* **api:** resolve swarm-field tool names by own-property ([#2123](https://github.com/Gitlawb/openclaude/issues/2123)) ([f553d08](https://github.com/Gitlawb/openclaude/commit/f553d0896d73f6a757bc73cd1bfd1f608345defc))
* **bg:** preserve detached session terminal outcomes ([#2133](https://github.com/Gitlawb/openclaude/issues/2133)) ([108a413](https://github.com/Gitlawb/openclaude/commit/108a4134931b02985e5baa828b5d406ab392a0f8))
* **code-reviewer:** require inline diff input and preserve read-only search in embedded-search builds ([#2102](https://github.com/Gitlawb/openclaude/issues/2102)) ([645d596](https://github.com/Gitlawb/openclaude/commit/645d596ea47e505544949e41a81379fb16ca138c))
* extend Ling 3.0 Tiny :free availability window to Aug 17 ([ee64d80](https://github.com/Gitlawb/openclaude/commit/ee64d80c2ee70f44739cf3bbf5e57ca14614fd66))
* Ling 3.0 Tiny :free window back to Aug 13 (official promo end) ([6277bfa](https://github.com/Gitlawb/openclaude/commit/6277bfadbc77aac733d090ad8f6dfdb727289fa6))
* **mcp:** paginate discovery list operations ([#2132](https://github.com/Gitlawb/openclaude/issues/2132)) ([e9e6beb](https://github.com/Gitlawb/openclaude/commit/e9e6beb15b13f792f2b7de37f775fde4c445f341))
* **web:** link release notes to GitHub ([#2114](https://github.com/Gitlawb/openclaude/issues/2114)) ([c40d663](https://github.com/Gitlawb/openclaude/commit/c40d663b70e9c9e3d3d7be5888b74507f11056d6))
* **websearch:** reject non-positive WEB_CUSTOM env overrides ([#2124](https://github.com/Gitlawb/openclaude/issues/2124)) ([6c7a12b](https://github.com/Gitlawb/openclaude/commit/6c7a12b2a2b1e125ef925785e7029a6d291aaad4))

## [0.28.0](https://github.com/Gitlawb/openclaude/compare/v0.27.0...v0.28.0) (2026-08-11)


### Features

* **cli:** add --yolo alias for --dangerously-skip-permissions ([#2097](https://github.com/Gitlawb/openclaude/issues/2097)) ([95eeb0b](https://github.com/Gitlawb/openclaude/commit/95eeb0bde38c4ba0e274877ee905c566ffe4e9cd))
* **codex:** move codexplan default to GPT-5.6 Sol ([#2051](https://github.com/Gitlawb/openclaude/issues/2051)) ([9540946](https://github.com/Gitlawb/openclaude/commit/95409464f3685f49e14060ec314997c3a0428901))
* **integrations:** add ApiSmart OpenAI-compatible gateway provider ([#2109](https://github.com/Gitlawb/openclaude/issues/2109)) ([ff91642](https://github.com/Gitlawb/openclaude/commit/ff91642364a7a751a99f4e999ad45600358717dd))
* **opengateway:** add Ling 3.0 Tiny :free — Day-0 launch, free until August 13 ([#2112](https://github.com/Gitlawb/openclaude/issues/2112)) ([7b03ad1](https://github.com/Gitlawb/openclaude/commit/7b03ad19a4672e5915959ed17f9e7ce3cbecf737))
* **opengateway:** free retirement — paid Ling id, dual Nemotron, Macaron Venti ([#2108](https://github.com/Gitlawb/openclaude/issues/2108)) ([54b9cd8](https://github.com/Gitlawb/openclaude/commit/54b9cd8389f070868f6d0be124d18898a99309c3))


### Bug Fixes

* **bash:** convert BRE interval braces when previewing sed edits ([#1955](https://github.com/Gitlawb/openclaude/issues/1955)) ([eb1de5b](https://github.com/Gitlawb/openclaude/commit/eb1de5b5767a3038336980bb50defcefe5659b4f))
* **cost:** guard model-cost lookup against prototype-member model ids ([#2064](https://github.com/Gitlawb/openclaude/issues/2064)) ([c327805](https://github.com/Gitlawb/openclaude/commit/c327805e1d00b5e689b7d0265c4b51a5d2370373))
* **input:** preserve text in DEL-coalesced chunks ([#2091](https://github.com/Gitlawb/openclaude/issues/2091)) ([1bf8076](https://github.com/Gitlawb/openclaude/commit/1bf8076d48252e3c41bf5ed584d69016954f2cf0))
* **mcp:** serialize OAuth and XAA refresh across processes ([#2093](https://github.com/Gitlawb/openclaude/issues/2093)) ([6465a51](https://github.com/Gitlawb/openclaude/commit/6465a516f2ae566305d4298e7fba208a02134f5f))
* **model-picker:** eliminate O(n²) catalog rebuild lag in /model ([#2078](https://github.com/Gitlawb/openclaude/issues/2078)) ([248424f](https://github.com/Gitlawb/openclaude/commit/248424ffe3d8da981ebbfd31c347eb197f88d262))
* **query:** use monotonic watchdog deadlines ([#2110](https://github.com/Gitlawb/openclaude/issues/2110)) ([16e332e](https://github.com/Gitlawb/openclaude/commit/16e332e10825bb0c4391bb82de745c8fea8d622c))
* **release:** synchronize web changelog entries ([#2088](https://github.com/Gitlawb/openclaude/issues/2088)) ([7743cf2](https://github.com/Gitlawb/openclaude/commit/7743cf280ed13b97b4bb2da1b0afde8d0757651a))
* **repl:** make local interactive max-turns configurable ([#2086](https://github.com/Gitlawb/openclaude/issues/2086)) ([b0cbfe1](https://github.com/Gitlawb/openclaude/commit/b0cbfe11000eef4d85b96fc3173afbb8b0930c81))
* **repomap:** resolve file language by real extension, own-property only ([#2100](https://github.com/Gitlawb/openclaude/issues/2100)) ([41d2f3b](https://github.com/Gitlawb/openclaude/commit/41d2f3b831c7c6b426c21fd466526d784ba547ff))
* **session:** make transcript replacements crash-safe ([#2094](https://github.com/Gitlawb/openclaude/issues/2094)) ([d834904](https://github.com/Gitlawb/openclaude/commit/d834904e5a3fc295484e78bcf564ca01adf3b1b8))
* **web:** add v0.27.0 changelog entry and clarify release-data ownership ([#2075](https://github.com/Gitlawb/openclaude/issues/2075)) ([63fda83](https://github.com/Gitlawb/openclaude/commit/63fda83d5578ddcc251eefa0c6800a85913895b5))


### Performance Improvements

* **cli:** enable Node module compile cache ([#2092](https://github.com/Gitlawb/openclaude/issues/2092)) ([d427a4b](https://github.com/Gitlawb/openclaude/commit/d427a4b2bb7b84564c5d2232de13942bc75fe9d2))

## [0.27.0](https://github.com/Gitlawb/openclaude/compare/v0.26.0...v0.27.0) (2026-07-30)


### Features

* **auth:** opt-in loopback proxy hosts that keep subscription (OAuth) auth ([#2050](https://github.com/Gitlawb/openclaude/issues/2050)) ([3925f27](https://github.com/Gitlawb/openclaude/commit/3925f2791cbd497dad0ba86b8797200a2f4f0449))
* **integrations:** add Ling 3.0 Flash free to the Opengateway catalog ([#2057](https://github.com/Gitlawb/openclaude/issues/2057)) ([3c5856a](https://github.com/Gitlawb/openclaude/commit/3c5856a004f53b16d214f6d65c32e2cc99821310))
* **opengateway:** add Macaron V1 Tall to the gateway catalog ([#2067](https://github.com/Gitlawb/openclaude/issues/2067)) ([e636f7d](https://github.com/Gitlawb/openclaude/commit/e636f7d1cb482a2c912e440a3790933741c2174d))
* **ui:** single-row centered startup logo with ANSI Shadow wordmark ([#2053](https://github.com/Gitlawb/openclaude/issues/2053)) ([12994f2](https://github.com/Gitlawb/openclaude/commit/12994f2c9783c29b9104f8ca7ec35af200448fed))
* **web:** replace favicon/logo with Ember Block O brand mark ([#2065](https://github.com/Gitlawb/openclaude/issues/2065)) ([56a9201](https://github.com/Gitlawb/openclaude/commit/56a920196d0e0496e7171da3be7258ed23fe37a8))
* **web:** v0.26 refresh — buddy page, changelog, partners, provider … ([#2060](https://github.com/Gitlawb/openclaude/issues/2060)) ([0f76b54](https://github.com/Gitlawb/openclaude/commit/0f76b5490b3e76e0c10327da1c2394e75da73f49))


### Bug Fixes

* **agents:** allow subagents from multi-repo parent sessions ([#2063](https://github.com/Gitlawb/openclaude/issues/2063)) ([8df37c7](https://github.com/Gitlawb/openclaude/commit/8df37c78f453163a71ea23e7e17999154492fa5e))
* **minimax:** mark MiniMax-M2.7 as text-only input ([#2068](https://github.com/Gitlawb/openclaude/issues/2068)) ([5cac15c](https://github.com/Gitlawb/openclaude/commit/5cac15cbdade9d531a1dc21e0901817218468f5d))
* **query:** do not trip tool-failure guard on parallel same-turn failures ([#2048](https://github.com/Gitlawb/openclaude/issues/2048)) ([9d5b77d](https://github.com/Gitlawb/openclaude/commit/9d5b77db89e550af358215c5411a6b799b69a4b1))
* **sdk:** report a permission timeout as a timeout ([#2028](https://github.com/Gitlawb/openclaude/issues/2028)) ([580a6b1](https://github.com/Gitlawb/openclaude/commit/580a6b11978ea7b65b5112224a2f74943b03f8a8))
* **stats:** stop over-counting totalDays by one ([#1953](https://github.com/Gitlawb/openclaude/issues/1953)) ([83440a6](https://github.com/Gitlawb/openclaude/commit/83440a6fe69d3f744d1d4488322c0518cdbd7bfe))
* **ui:** keep SpinnerModeGlyph visible inside status parens ([#2047](https://github.com/Gitlawb/openclaude/issues/2047)) ([10a9190](https://github.com/Gitlawb/openclaude/commit/10a9190bea37bf8574bdb1b040180bf3b84ba2b3))
* **web:** make web/ build standalone — stop importing the repo-root p… ([#2061](https://github.com/Gitlawb/openclaude/issues/2061)) ([c2030bb](https://github.com/Gitlawb/openclaude/commit/c2030bbb2bd62fc56a8dd58748e039682e05aa97))

## [0.26.0](https://github.com/Gitlawb/openclaude/compare/v0.25.0...v0.26.0) (2026-07-27)


### Features

* **aimlapi:** add passwordless client methods and response-shape guards (2/N) ([#2020](https://github.com/Gitlawb/openclaude/issues/2020)) ([022f057](https://github.com/Gitlawb/openclaude/commit/022f057a3c13e42d710134c100961e50425e31a2))


### Bug Fixes

* apply ultrathink effort to provider requests ([#2046](https://github.com/Gitlawb/openclaude/issues/2046)) ([53d3cf7](https://github.com/Gitlawb/openclaude/commit/53d3cf7f1dde95603a72a1eb1d678560d3a4a9d3))
* **bridge:** truncate derived session titles on grapheme boundaries ([#1982](https://github.com/Gitlawb/openclaude/issues/1982)) ([a6b3d7a](https://github.com/Gitlawb/openclaude/commit/a6b3d7a209243c267889aa0e9e3d44700364fb54))
* **cache-probe:** omit unsupported cache request fields ([#2044](https://github.com/Gitlawb/openclaude/issues/2044)) ([a652013](https://github.com/Gitlawb/openclaude/commit/a65201396a47f17e41ef2d49d4db9a68e88b4a10))
* **commands:** insert slash-command argument text literally, not as regex refs ([#1966](https://github.com/Gitlawb/openclaude/issues/1966)) ([62d15d4](https://github.com/Gitlawb/openclaude/commit/62d15d40a6cdb9c99c42c6b783b69be9c677b0fa))
* **fs:** tolerate EPERM from mkdir on Windows drive roots ([#2026](https://github.com/Gitlawb/openclaude/issues/2026)) ([5f6c608](https://github.com/Gitlawb/openclaude/commit/5f6c60851a32ae1e84259087755a18e1e6207015))
* **memory:** match nested directories on path boundaries, not name prefixes ([#1974](https://github.com/Gitlawb/openclaude/issues/1974)) ([0ff1d1c](https://github.com/Gitlawb/openclaude/commit/0ff1d1cb7b7513d298fc0a564b8f1be1a7c95c9a))
* **query:** keep long-running tools active ([#2022](https://github.com/Gitlawb/openclaude/issues/2022)) ([c23b6e1](https://github.com/Gitlawb/openclaude/commit/c23b6e1c64b03862cb15ecf59da8dca38e9cb27f))
* **ui:** show streaming token count immediately ([#2030](https://github.com/Gitlawb/openclaude/issues/2030)) ([01a01fb](https://github.com/Gitlawb/openclaude/commit/01a01fb0337e4b5376b26a0c76b50291fa125a7e))

## [0.25.0](https://github.com/Gitlawb/openclaude/compare/v0.24.0...v0.25.0) (2026-07-20)


### Features

* add LongCat as first-class OpenAI-compatible provider ([#1986](https://github.com/Gitlawb/openclaude/issues/1986)) ([8f81e48](https://github.com/Gitlawb/openclaude/commit/8f81e48f0e9fe4bc6efdcc00c47be04020b0d798))
* **aimlapi:** provider foundation (1/5) — config, catalog, ambient-key gate ([#1995](https://github.com/Gitlawb/openclaude/issues/1995)) ([7674d4d](https://github.com/Gitlawb/openclaude/commit/7674d4d73ef69265da764a92194085ffc4202d95))
* **buddy:** hero pixel-art companions with signature Enter animations ([#1972](https://github.com/Gitlawb/openclaude/issues/1972)) ([d683e85](https://github.com/Gitlawb/openclaude/commit/d683e85395c5477a40b273847050ac4fdfbab9ca))
* **codex:** add GPT-5.6 family models and fix saved-model rehydration ([#2014](https://github.com/Gitlawb/openclaude/issues/2014)) ([cb460e5](https://github.com/Gitlawb/openclaude/commit/cb460e516b3fdc95aef17f38fd395bf706db3984))
* **install:** enforce and guard the zero-warning npm install contract ([#2019](https://github.com/Gitlawb/openclaude/issues/2019)) ([ca7a7e0](https://github.com/Gitlawb/openclaude/commit/ca7a7e0791c4e9e08832f8678df77ed632842f6b))
* **kimi:** add Kimi K3 context variants ([#1989](https://github.com/Gitlawb/openclaude/issues/1989)) ([e3fb051](https://github.com/Gitlawb/openclaude/commit/e3fb051775ccf4dd0740c5425442a7af1702b002))
* **onboarding:** first-run experience for third-party providers ([#1864](https://github.com/Gitlawb/openclaude/issues/1864)) ([fff83a1](https://github.com/Gitlawb/openclaude/commit/fff83a1a7fa81b1635a2ecb35af476c194dfdac6))
* **perf:** tier1 token optimization — universal tool compression, doom loop detection, configurable compaction ([#1869](https://github.com/Gitlawb/openclaude/issues/1869)) ([83d54b0](https://github.com/Gitlawb/openclaude/commit/83d54b0ac8b59056a98d58f80f4b4ad1bfa22969))
* **provider:** route GPT-5.6 models to the OpenAI Responses API ([#1961](https://github.com/Gitlawb/openclaude/issues/1961)) ([de76950](https://github.com/Gitlawb/openclaude/commit/de76950f607e6f885f35327aeab00b6e6888dd50))
* **statusline:** show token counts in context bar (ctx 74K/200K (37%)) ([#1967](https://github.com/Gitlawb/openclaude/issues/1967)) ([626c487](https://github.com/Gitlawb/openclaude/commit/626c4873abe234e04130663c4b9bf38f2ce8c1a3))


### Bug Fixes

* **api:** enforce API_TIMEOUT_MS for OpenAI-compatible headers ([#1940](https://github.com/Gitlawb/openclaude/issues/1940)) ([3808d19](https://github.com/Gitlawb/openclaude/commit/3808d19da4a0659f59479ad1a6b163de62d84144))
* **api:** self-heal `tool_stream` rejection from non-Z.AI gateways ([#1950](https://github.com/Gitlawb/openclaude/issues/1950)) ([#1951](https://github.com/Gitlawb/openclaude/issues/1951)) ([487cae7](https://github.com/Gitlawb/openclaude/commit/487cae7185b423bfe31a5e014b13bdf2557a25a1))
* **compaction:** honor disabled auto-compact under memory pressure ([#1999](https://github.com/Gitlawb/openclaude/issues/1999)) ([630fc2d](https://github.com/Gitlawb/openclaude/commit/630fc2d9804d5a1c4ec5bca1a3af00d92ea55917))
* **memdir:** enforce entrypoint cap in bytes, not UTF-16 char length ([#1918](https://github.com/Gitlawb/openclaude/issues/1918)) ([7b9e477](https://github.com/Gitlawb/openclaude/commit/7b9e477519f6965b19f4c0db70ae410e3586a72c))
* **openai:** compress tool history on Responses requests ([#1958](https://github.com/Gitlawb/openclaude/issues/1958)) ([5399a11](https://github.com/Gitlawb/openclaude/commit/5399a11d3c30713c9627697fdc6baa3e3a603f97))
* **output-style:** resolve style names by own-property ([#2023](https://github.com/Gitlawb/openclaude/issues/2023)) ([722e0c3](https://github.com/Gitlawb/openclaude/commit/722e0c31cecbf691f3458aa4c36cf44281cfcd5e))
* **permissions:** enforce read-only plan mode ([#1938](https://github.com/Gitlawb/openclaude/issues/1938)) ([1f20e92](https://github.com/Gitlawb/openclaude/commit/1f20e92c2ef0a164b63c24d0515479113fdbe6b5))
* **provider:** support custom Anthropic bearer auth ([#1929](https://github.com/Gitlawb/openclaude/issues/1929)) ([46e8056](https://github.com/Gitlawb/openclaude/commit/46e80568bed735542cd8ecb8c5d8eaa9d6e9eb2b))
* **query:** bound per-turn latency growth in long REPL sessions ([#1949](https://github.com/Gitlawb/openclaude/issues/1949)) ([#1952](https://github.com/Gitlawb/openclaude/issues/1952)) ([a327815](https://github.com/Gitlawb/openclaude/commit/a32781537f4c8a64940b9a93d70ad55351ff8b5d))
* **repl:** add correction context after interruption ([#1936](https://github.com/Gitlawb/openclaude/issues/1936)) ([eb72c77](https://github.com/Gitlawb/openclaude/commit/eb72c770c404dd487cb0939ff94875606ea4b7bd))
* **resume:** read the session tag from its own entry, not a tool's tag input ([#1975](https://github.com/Gitlawb/openclaude/issues/1975)) ([1d053b2](https://github.com/Gitlawb/openclaude/commit/1d053b2a3d9729a25a5925520b75c6f1d8ec9c41))
* **session-title:** ignore API error responses ([#1992](https://github.com/Gitlawb/openclaude/issues/1992)) ([86fb6db](https://github.com/Gitlawb/openclaude/commit/86fb6db85c189150ab5985273469c1ac44454ccd))


### Performance Improvements

* **tools:** preserve UTF-8-safe head and tail in persisted previews ([#1960](https://github.com/Gitlawb/openclaude/issues/1960)) ([507ba4b](https://github.com/Gitlawb/openclaude/commit/507ba4b8041302927d3ce1ac64f3397bdbf95329))

## [0.24.0](https://github.com/Gitlawb/openclaude/compare/v0.23.0...v0.24.0) (2026-07-14)


### Features

* add ultrathink keyword detection and ultracode effort level ([#1551](https://github.com/Gitlawb/openclaude/issues/1551)) ([#1630](https://github.com/Gitlawb/openclaude/issues/1630)) ([fb11372](https://github.com/Gitlawb/openclaude/commit/fb1137275a23c821d6f4bf55cbb88c08c65211fa))
* **aimlapi:** add guided top-up and key provisioning ([#1886](https://github.com/Gitlawb/openclaude/issues/1886)) ([9a53290](https://github.com/Gitlawb/openclaude/commit/9a532905886fc2fe1684a283d435bca0f361bbe2))
* **codex-oauth:** manual callback URL paste for SSH / remote sessions ([#1288](https://github.com/Gitlawb/openclaude/issues/1288)) ([#1414](https://github.com/Gitlawb/openclaude/issues/1414)) ([c3db07f](https://github.com/Gitlawb/openclaude/commit/c3db07f1f255ed42afe3fc6c74a338ff235f28fd))
* **doctor:** add WebSearch backend diagnostics ([#1884](https://github.com/Gitlawb/openclaude/issues/1884)) ([e204d5a](https://github.com/Gitlawb/openclaude/commit/e204d5ad363d8bdafd8ed84460f26d49b1a72d9e))
* **model-picker:** surface inactive provider profiles in /model ([#1119](https://github.com/Gitlawb/openclaude/issues/1119) piece 2) ([#1164](https://github.com/Gitlawb/openclaude/issues/1164)) ([db01038](https://github.com/Gitlawb/openclaude/commit/db01038d5ce397e1cd4228f55075ef7b21cc2553))
* **provider:** add Cloudflare Workers AI integration ([#1100](https://github.com/Gitlawb/openclaude/issues/1100)) ([#1178](https://github.com/Gitlawb/openclaude/issues/1178)) ([eeed68f](https://github.com/Gitlawb/openclaude/commit/eeed68f4fd6ffbdc4ac13928e943a3e93141b210))
* **settings:** add settings-based subscription override and agy terminal support ([#1731](https://github.com/Gitlawb/openclaude/issues/1731)) ([a5b2779](https://github.com/Gitlawb/openclaude/commit/a5b277971d078ffc62fea7fb1be6deba367bfe29))
* **settings:** per-model context_window and max_output_tokens overrides ([#1234](https://github.com/Gitlawb/openclaude/issues/1234)) ([06e0ae6](https://github.com/Gitlawb/openclaude/commit/06e0ae6e0b6f7db5b3311f407c009e8af27405c1))


### Bug Fixes

* **bg:** match background-session command args on token boundaries ([#1834](https://github.com/Gitlawb/openclaude/issues/1834)) ([67bebbd](https://github.com/Gitlawb/openclaude/commit/67bebbdaca9efc93f4fd5ecfe75dfda9b9a49bed))
* **bg:** revalidate process identity before signals ([#1937](https://github.com/Gitlawb/openclaude/issues/1937)) ([af0885d](https://github.com/Gitlawb/openclaude/commit/af0885d8ec3aac08259a37f42b51818a2576f91c))
* **cache:** use a monotonic clock for conversation-cache LRU recency ([#1965](https://github.com/Gitlawb/openclaude/issues/1965)) ([9fc8806](https://github.com/Gitlawb/openclaude/commit/9fc8806f8d79858bf9c2433178687e674f2510b1))
* **clipboard:** fall back to image retrieval after Windows probe failure ([#1922](https://github.com/Gitlawb/openclaude/issues/1922)) ([218064e](https://github.com/Gitlawb/openclaude/commit/218064e37673364afe2178a9ccb9be5d0b66c00d))
* **command-semantics:** cover remaining linter runner exits ([#1700](https://github.com/Gitlawb/openclaude/issues/1700)) ([3b41cf3](https://github.com/Gitlawb/openclaude/commit/3b41cf3adb4c6a6dcadd113a83277ddc95fc2052))
* **command-semantics:** treat linter exit 1 as violations, not an error ([#1846](https://github.com/Gitlawb/openclaude/issues/1846)) ([2f98208](https://github.com/Gitlawb/openclaude/commit/2f98208eafdc121f3d8308060016ee7363519ac7))
* **commands:** escape named-argument names before building the regex ([#1914](https://github.com/Gitlawb/openclaude/issues/1914)) ([3f85b25](https://github.com/Gitlawb/openclaude/commit/3f85b255ddf85db76d99a04b4df4baba81485ec0))
* **config:** recover from a healthy backup when the global config is corrupt ([#1819](https://github.com/Gitlawb/openclaude/issues/1819)) ([5105dff](https://github.com/Gitlawb/openclaude/commit/5105dff5f4fe05d1fd177bc62c7712c9ff5374e0))
* **context:** order pruned messages by envelope timestamp, not phantom field ([#1934](https://github.com/Gitlawb/openclaude/issues/1934)) ([2970b5f](https://github.com/Gitlawb/openclaude/commit/2970b5fd5f94ffd5a5121ebe5dc655c079b2ec51))
* **diff:** count dropped lines correctly in truncated diff snippet ([#1916](https://github.com/Gitlawb/openclaude/issues/1916)) ([87c457c](https://github.com/Gitlawb/openclaude/commit/87c457c2fa610ec563132af561ec5858d7683eaa))
* **diff:** don't overcount new-file additions by the trailing newline ([#1873](https://github.com/Gitlawb/openclaude/issues/1873)) ([8d90849](https://github.com/Gitlawb/openclaude/commit/8d90849fe6567b82b8e0915b5f5b9c5de6e690b5))
* **diff:** number diff-snippet hunks by their new-file position ([#1917](https://github.com/Gitlawb/openclaude/issues/1917)) ([0369c86](https://github.com/Gitlawb/openclaude/commit/0369c86e3ba2c1ae44a707af981ce52a67ec0250))
* **editor:** account for NFC boundary composition in insert offset ([#1954](https://github.com/Gitlawb/openclaude/issues/1954)) ([ed3927d](https://github.com/Gitlawb/openclaude/commit/ed3927d0f547ddee44ee584e58858942490649de))
* **editor:** guard editor-override lookup against prototype keys ([#1915](https://github.com/Gitlawb/openclaude/issues/1915)) ([de751f3](https://github.com/Gitlawb/openclaude/commit/de751f369c8348a8ed0561011a311903e8780839))
* **effort:** keep effort indicator visible in prompt footer ([#1919](https://github.com/Gitlawb/openclaude/issues/1919)) ([b588c26](https://github.com/Gitlawb/openclaude/commit/b588c26db2bd097db72706b1fb366e48e9cb346e))
* **env:** align WebSearch and Ollama env docs ([#1904](https://github.com/Gitlawb/openclaude/issues/1904)) ([ae9a765](https://github.com/Gitlawb/openclaude/commit/ae9a765fb5fb1fd188ccd81c7848bc84a85dbaa3))
* **gitdiff:** apply the 1MB diff cap in bytes, not UTF-16 char length ([#1932](https://github.com/Gitlawb/openclaude/issues/1932)) ([ffc5a6e](https://github.com/Gitlawb/openclaude/commit/ffc5a6e8fca3afc39ed2a7cede30b7891836a20f))
* **installer:** gate native-binary install behind NATIVE_PACKAGE_URL ([#1838](https://github.com/Gitlawb/openclaude/issues/1838)) ([780f703](https://github.com/Gitlawb/openclaude/commit/780f7037470521f9f6f705e21bce10d811541eeb))
* keep footer mounted across slash suggestions ([#1943](https://github.com/Gitlawb/openclaude/issues/1943)) ([4faf666](https://github.com/Gitlawb/openclaude/commit/4faf666cbab729a4f93493f8d4137d4bc0a29776))
* **mcp:** preserve ":-" inside ${VAR:-default} default values ([#1933](https://github.com/Gitlawb/openclaude/issues/1933)) ([9bf9926](https://github.com/Gitlawb/openclaude/commit/9bf9926805cefbef627398dad6b69ac1bb640cb3))
* **model:** default NVIDIA NIM main loop model ([#1928](https://github.com/Gitlawb/openclaude/issues/1928)) ([5918e33](https://github.com/Gitlawb/openclaude/commit/5918e330b294e3957eee3d41e93c77ffe607279c))
* **nvidia-nim:** enable reasoning template kwargs ([#1893](https://github.com/Gitlawb/openclaude/issues/1893)) ([de97295](https://github.com/Gitlawb/openclaude/commit/de9729500bd4a16f3e61e5abc0577eac95af1024))
* **openai-shim:** guard tool-arg field lookup against prototype keys ([#1880](https://github.com/Gitlawb/openclaude/issues/1880)) ([aac2d8c](https://github.com/Gitlawb/openclaude/commit/aac2d8cdc8368d404bb1fba56bf69a9da5279e19))
* **permissions:** resolve relative worktree edit paths ([#1930](https://github.com/Gitlawb/openclaude/issues/1930)) ([4f971a1](https://github.com/Gitlawb/openclaude/commit/4f971a1316c3773c1b1691133b15533e0d78ea17))
* **powershell:** make CMDLET_PATH_CONFIG prototype-safe ([#1913](https://github.com/Gitlawb/openclaude/issues/1913)) ([7995b9f](https://github.com/Gitlawb/openclaude/commit/7995b9f4920248a20a139d5d8b11ec10b6a07223))
* **provider:** add Use Anthropic option to switch back from third-party profiles ([#1429](https://github.com/Gitlawb/openclaude/issues/1429)) ([f7d472e](https://github.com/Gitlawb/openclaude/commit/f7d472e826d28d798931f48d0cf09c23387bcc2f))
* **proxy:** bypass subdomains for a bare NO_PROXY domain entry ([#1848](https://github.com/Gitlawb/openclaude/issues/1848)) ([a46046e](https://github.com/Gitlawb/openclaude/commit/a46046ee90a4efe292d7c0b404c58382f7e43133))
* **query-guard:** exclude human-interaction wait from session timeout ([#1879](https://github.com/Gitlawb/openclaude/issues/1879)) ([2047fb2](https://github.com/Gitlawb/openclaude/commit/2047fb250f1a1178f81430d1a381c4c64d631ab2))
* **query:** warn before repeated tool failures stop ([#1927](https://github.com/Gitlawb/openclaude/issues/1927)) ([2448ea9](https://github.com/Gitlawb/openclaude/commit/2448ea9bfe99171d2ae9e3a8513f373fb46c7d4f))
* **read:** report zero lines for an empty file ([#1881](https://github.com/Gitlawb/openclaude/issues/1881)) ([cde6e09](https://github.com/Gitlawb/openclaude/commit/cde6e090d31d376f8009d3a7af850350a99b60b2))
* **safety:** relax over-restrictive safety checks for benign coding tasks ([#1897](https://github.com/Gitlawb/openclaude/issues/1897)) ([e086e8c](https://github.com/Gitlawb/openclaude/commit/e086e8c35a3b4ceea6ada5d71ad403c5e85e0861))
* **shim:** don't infer Z.AI tool_stream for non-catalog GLM gateways ([#1908](https://github.com/Gitlawb/openclaude/issues/1908)) ([2259c80](https://github.com/Gitlawb/openclaude/commit/2259c809f7e36a419e787cb0397ba3727b6e25c4))
* suspend footer work during ctrl-c feedback ([#1963](https://github.com/Gitlawb/openclaude/issues/1963)) ([f961ae7](https://github.com/Gitlawb/openclaude/commit/f961ae743264d432ff1cc742385b5085f54e86df))
* **tokens:** include attachments in incremental cache key ([#800](https://github.com/Gitlawb/openclaude/issues/800)) ([5afd4f4](https://github.com/Gitlawb/openclaude/commit/5afd4f4d1061961bc667e7f4f0fabf76ca235e4d))
* **tools:** keep HY3 tool schemas inline ([#1923](https://github.com/Gitlawb/openclaude/issues/1923)) ([64d164d](https://github.com/Gitlawb/openclaude/commit/64d164d207cb5d10ec0d08120b13bcf9c05cdfb7))
* **update:** avoid upstream package commands for custom builds ([#1944](https://github.com/Gitlawb/openclaude/issues/1944)) ([85cf2ac](https://github.com/Gitlawb/openclaude/commit/85cf2ac55a3ccceae2fc8e522443fbdc9b1304e8))
* **websearch:** add built-in provider request timeouts ([#1874](https://github.com/Gitlawb/openclaude/issues/1874)) ([8599560](https://github.com/Gitlawb/openclaude/commit/8599560b8265f793df2d06041993f25c21dbf190))
* **websearch:** match allowed/blocked domains case-insensitively ([#1872](https://github.com/Gitlawb/openclaude/issues/1872)) ([2308881](https://github.com/Gitlawb/openclaude/commit/230888181a42c71fc452539cf8802189e28bb297))


### Performance Improvements

* bound file IO concurrency ([#1948](https://github.com/Gitlawb/openclaude/issues/1948)) ([c11c88b](https://github.com/Gitlawb/openclaude/commit/c11c88bd91c971a4ce401e0444fdbe70eec33ff6))

## [0.23.0](https://github.com/Gitlawb/openclaude/compare/v0.22.0...v0.23.0) (2026-07-07)


### Features

* add repo map codebase intelligence ([#1867](https://github.com/Gitlawb/openclaude/issues/1867)) ([fb40d49](https://github.com/Gitlawb/openclaude/commit/fb40d49e681c4b30e9a6f5eacbec269a35c01aff))
* **provider:** add AI/ML API provider ([#863](https://github.com/Gitlawb/openclaude/issues/863)) ([8369f20](https://github.com/Gitlawb/openclaude/commit/8369f2018ecda0f96f6cab10b24268b8f44dce73))
* **skills:** add local skill CLI support ([#1162](https://github.com/Gitlawb/openclaude/issues/1162)) ([214ee3d](https://github.com/Gitlawb/openclaude/commit/214ee3dd2e407947531509b55348a81d287ebd66))
* **skills:** add PDF generation skill with native TypeScript implementation ([#1718](https://github.com/Gitlawb/openclaude/issues/1718)) ([e9a3c30](https://github.com/Gitlawb/openclaude/commit/e9a3c308fc576ce690c37b75267f62c0ca56cf2c))
* smart auto-routing (per-turn simple-vs-strong model selection) ([#1734](https://github.com/Gitlawb/openclaude/issues/1734)) ([e2bbb02](https://github.com/Gitlawb/openclaude/commit/e2bbb0295a16cdeb6d24c9d6ff1ead727caba036))


### Bug Fixes

* await main() in cli entrypoint to prevent premature exit in Node 24.x ([#1697](https://github.com/Gitlawb/openclaude/issues/1697)) ([f292b05](https://github.com/Gitlawb/openclaude/commit/f292b057b59729b7aa5e06cfa2aea28a45a578c0))
* **compact:** count string message content ([#847](https://github.com/Gitlawb/openclaude/issues/847)) ([766d3f8](https://github.com/Gitlawb/openclaude/commit/766d3f8794cefb9e357499807f2af8ebc696978a))
* **deps:** ship a zero-warning, minimal install ([#1784](https://github.com/Gitlawb/openclaude/issues/1784)) ([2edec9a](https://github.com/Gitlawb/openclaude/commit/2edec9a1407b6afd1d12260fca20c59c771269f6))
* **diff:** guard diff language detection against prototype-chain filenames ([#1433](https://github.com/Gitlawb/openclaude/issues/1433)) ([7d86174](https://github.com/Gitlawb/openclaude/commit/7d861743caf95a18a9524b4a2b5c51f06fea6cde))
* guard convertToLogOption against empty transcript ([#1723](https://github.com/Gitlawb/openclaude/issues/1723)) ([4a60c0f](https://github.com/Gitlawb/openclaude/commit/4a60c0f30f7f81c19a4538cbc55d0030b470126e))
* **hicap:** add missing hicap-claude-opus-4.7 catalog entry ([#1797](https://github.com/Gitlawb/openclaude/issues/1797)) ([885bd81](https://github.com/Gitlawb/openclaude/commit/885bd81045d4370fef028d129e0930159cbefcf8))
* isolate OpenClaude config from Claude Code ([#1875](https://github.com/Gitlawb/openclaude/issues/1875)) ([1bd273d](https://github.com/Gitlawb/openclaude/commit/1bd273d4d3e551a64000b268a79bee7cb6946d8a))
* **lsp:** coalesce diagnostic bursts ([#1861](https://github.com/Gitlawb/openclaude/issues/1861)) ([11f4661](https://github.com/Gitlawb/openclaude/commit/11f4661ea99f559da5203570b0f47b49a4b26072))
* **opencode-go:** surface clear error on subscription quota exhaustion ([#1749](https://github.com/Gitlawb/openclaude/issues/1749)) ([b8c8b24](https://github.com/Gitlawb/openclaude/commit/b8c8b2417bb329d8757d38c236868f2a23f0f535))
* resolve zai-compatible config for all GLM remote models ([#1752](https://github.com/Gitlawb/openclaude/issues/1752)) ([4be017b](https://github.com/Gitlawb/openclaude/commit/4be017bd4dca1fc757e1664292c12a7057e8b05b))

## [0.22.0](https://github.com/Gitlawb/openclaude/compare/v0.21.0...v0.22.0) (2026-07-06)


### Features

* **lsp:** expose captured diagnostics ([#1813](https://github.com/Gitlawb/openclaude/issues/1813)) ([5b1db55](https://github.com/Gitlawb/openclaude/commit/5b1db554fde3fa9651ab38b53f773231d6df8b7e))
* **report:** render task reports as markdown ([#1826](https://github.com/Gitlawb/openclaude/issues/1826)) ([8182a46](https://github.com/Gitlawb/openclaude/commit/8182a46441793a33aebb5837bd759e9dc0a38eff))
* **resume:** group branched sessions in picker ([#1824](https://github.com/Gitlawb/openclaude/issues/1824)) ([166d0ce](https://github.com/Gitlawb/openclaude/commit/166d0ce7843f33d355caddf9c49473d9d1133446))
* **ux:** honest feedback pass — visible retries, statusline truncation marker, hint grace period ([#1862](https://github.com/Gitlawb/openclaude/issues/1862)) ([77c0a0d](https://github.com/Gitlawb/openclaude/commit/77c0a0d7806e2698ca3716bbfd6373f39b161f10))


### Bug Fixes

* **api:** quiet expected side-task aborts ([#1868](https://github.com/Gitlawb/openclaude/issues/1868)) ([62fa7d4](https://github.com/Gitlawb/openclaude/commit/62fa7d48c158f40c085fd9ee1a78e315b868c44a))
* **bash:** share parser analysis across checks ([#1735](https://github.com/Gitlawb/openclaude/issues/1735)) ([cd1cf3c](https://github.com/Gitlawb/openclaude/commit/cd1cf3ca707f9008705dcc412630975822ca238e))
* **bash:** surface rolled-output file path on non-zero exit ([#1359](https://github.com/Gitlawb/openclaude/issues/1359)) ([#1392](https://github.com/Gitlawb/openclaude/issues/1392)) ([0c9b814](https://github.com/Gitlawb/openclaude/commit/0c9b81493a0780d9debb245fbff66a32c37c5fc2))
* **bash:** use indexOf instead of lastIndexOf for multi-flag shell prefix ([#1851](https://github.com/Gitlawb/openclaude/issues/1851)) ([68fcb91](https://github.com/Gitlawb/openclaude/commit/68fcb919307fe247a88d163224b53b045c65b754))
* bound profiler performance entries ([#1865](https://github.com/Gitlawb/openclaude/issues/1865)) ([ad796e0](https://github.com/Gitlawb/openclaude/commit/ad796e0d9f8284baa0d9d32543bc8d5a6a92776c))
* **build:** shim jsxDEV when bundling production React — TUI rendered nothing ([#1863](https://github.com/Gitlawb/openclaude/issues/1863)) ([203f055](https://github.com/Gitlawb/openclaude/commit/203f05538e4c84b9f368f716ff87c9a47d74aab2))
* **clipboard:** use .NET Clipboard.GetImage() for Windows raw bitmap paste ([#1855](https://github.com/Gitlawb/openclaude/issues/1855)) ([2ac20c7](https://github.com/Gitlawb/openclaude/commit/2ac20c759b5c026b1e12112920a5c59b95bacceb))
* **codex:** make Codex alias lookup prototype-safe ([#1833](https://github.com/Gitlawb/openclaude/issues/1833)) ([d03b6a8](https://github.com/Gitlawb/openclaude/commit/d03b6a879c0cad7d4133ea2d2e2488c25098ea63))
* **format:** show sub-second durations with one decimal instead of "0s" ([#1820](https://github.com/Gitlawb/openclaude/issues/1820)) ([784d9a9](https://github.com/Gitlawb/openclaude/commit/784d9a92ef3b59daa948ca1a11e8fa7707f85fd9))
* **gitdiff:** count in-hunk lines that start with ++ or -- in raw diff stats ([#1843](https://github.com/Gitlawb/openclaude/issues/1843)) ([069febb](https://github.com/Gitlawb/openclaude/commit/069febb737b64a8b409ce0adab35a8b56879ca48))
* governance controls for memory and git attribution ([#1806](https://github.com/Gitlawb/openclaude/issues/1806)) ([00b8c15](https://github.com/Gitlawb/openclaude/commit/00b8c15b5b2bed3724288282a2faf5358a704e37))
* **lsp:** suppress empty diagnostic deliveries ([#1859](https://github.com/Gitlawb/openclaude/issues/1859)) ([9700bd3](https://github.com/Gitlawb/openclaude/commit/9700bd3c41d2630e3e2eea22ae328b8562155d48))
* **memory:** prevent reported idle retention paths ([#1856](https://github.com/Gitlawb/openclaude/issues/1856)) ([354feb4](https://github.com/Gitlawb/openclaude/commit/354feb483cecc3724d4bdb9a1cf816c2d2e4e166))
* **memory:** recover from autocompact overflow failures ([#1858](https://github.com/Gitlawb/openclaude/issues/1858)) ([cd13a61](https://github.com/Gitlawb/openclaude/commit/cd13a615370e4bd79544c8e973df065924c41e86))
* **memoryscan:** abort remaining workers when one throws on iterator … ([#1836](https://github.com/Gitlawb/openclaude/issues/1836)) ([b73a879](https://github.com/Gitlawb/openclaude/commit/b73a879c546fcf632d9ad946ee8b0b2c038fe2a8))
* **model:** resolve [1m]-tagged aliases when 1M context is disabled ([#1822](https://github.com/Gitlawb/openclaude/issues/1822)) ([e6019d3](https://github.com/Gitlawb/openclaude/commit/e6019d379704aa9f0d89fc9dd8a69e24a3dee408))
* **openai-shim:** recover stalled provider streams ([#1817](https://github.com/Gitlawb/openclaude/issues/1817)) ([67227cf](https://github.com/Gitlawb/openclaude/commit/67227cf7723beb53f09e38dece2e4ba09a1f8f10))
* **openai-shim:** strip `store` when baseUrl points at Mistral ([#1047](https://github.com/Gitlawb/openclaude/issues/1047)) ([deb4176](https://github.com/Gitlawb/openclaude/commit/deb41761c100ffdebddb43fa38fc341d0915c52f)), closes [#739](https://github.com/Gitlawb/openclaude/issues/739)
* **openai-shim:** wire stream controller abort ([#1828](https://github.com/Gitlawb/openclaude/issues/1828)) ([bb61d84](https://github.com/Gitlawb/openclaude/commit/bb61d8430bd14f75e7054f2099c2c1eb71c221d5))
* **permissions:** make legacy tool-name alias lookup prototype-safe ([#1847](https://github.com/Gitlawb/openclaude/issues/1847)) ([b9b5685](https://github.com/Gitlawb/openclaude/commit/b9b5685143b524541766211c6f262ea38cd5fef3))
* **plugins:** match reserved-marketplace git URL owner by host, not substring ([#1840](https://github.com/Gitlawb/openclaude/issues/1840)) ([17f4a5b](https://github.com/Gitlawb/openclaude/commit/17f4a5b963532eec76beb7ba9d90062828f474ad))
* **query:** clean up lifecycle tool tracking ([#1845](https://github.com/Gitlawb/openclaude/issues/1845)) ([d1530c2](https://github.com/Gitlawb/openclaude/commit/d1530c28aa1788a9be78773f4ecec13f82a1f083))
* **query:** configure hard max and abort reasons ([#1850](https://github.com/Gitlawb/openclaude/issues/1850)) ([5226fb9](https://github.com/Gitlawb/openclaude/commit/5226fb9ee7e912a5a0beccc3f0e3e9fc6a8c041b))

## [0.21.0](https://github.com/Gitlawb/openclaude/compare/v0.20.1...v0.21.0) (2026-06-30)


### Features

* add /set-context-window and /clear-context-window commands ([#1810](https://github.com/Gitlawb/openclaude/issues/1810)) ([5a79697](https://github.com/Gitlawb/openclaude/commit/5a7969785a81a5305f9514693bf236f31854912f))
* **agents:** add per-agent step limits ([#1815](https://github.com/Gitlawb/openclaude/issues/1815)) ([1827d84](https://github.com/Gitlawb/openclaude/commit/1827d8470997e379daf1459d543f88b224b1cec2))
* **claude:** add Opus 4.8 model support ([#1769](https://github.com/Gitlawb/openclaude/issues/1769)) ([9c29811](https://github.com/Gitlawb/openclaude/commit/9c298112dc78b4dbf005775b4ee026dc5ffe38db))
* **cli:** add headless heartbeat for print mode ([#1789](https://github.com/Gitlawb/openclaude/issues/1789)) ([eea0a1a](https://github.com/Gitlawb/openclaude/commit/eea0a1a740de09d00e68e27a5b9ab442e84b89a9))
* **ClinePass:** add gateway provider with usage support ([#1818](https://github.com/Gitlawb/openclaude/issues/1818)) ([985984b](https://github.com/Gitlawb/openclaude/commit/985984b9ffdf32bdd62fa01f0acbf69b135a2a53))
* **effort:** Add model-level reasoning effort routing ([#1780](https://github.com/Gitlawb/openclaude/issues/1780)) ([cb689cc](https://github.com/Gitlawb/openclaude/commit/cb689cc33a1762c79f54085e76aeadddd939f22a))
* **report:** generate deterministic session task reports ([#1802](https://github.com/Gitlawb/openclaude/issues/1802)) ([a474933](https://github.com/Gitlawb/openclaude/commit/a47493342f251c98ebed6595768697dc22466715))
* **session:** add branch command for conversation forks ([#1808](https://github.com/Gitlawb/openclaude/issues/1808)) ([9bf6aa2](https://github.com/Gitlawb/openclaude/commit/9bf6aa230890a0ed116e1157eb93d4fa0d20085d))
* **session:** harden fork-session branching ([#1801](https://github.com/Gitlawb/openclaude/issues/1801)) ([8023356](https://github.com/Gitlawb/openclaude/commit/8023356841f9cce872d93641f18ca7584f91a10d))


### Bug Fixes

* **atlas-cloud:** vendor to gateway catalog correction and added reasoning support ([#1785](https://github.com/Gitlawb/openclaude/issues/1785)) ([40faf25](https://github.com/Gitlawb/openclaude/commit/40faf256db67b635e0fbf1d66a0e00beca38fd61))
* auto-continuation overly biased toward Claude-style output — breaks with non-Claude models ([#1713](https://github.com/Gitlawb/openclaude/issues/1713)) ([a5a8ccc](https://github.com/Gitlawb/openclaude/commit/a5a8ccc378e1fb051c80edd071a692d96cecbf98))
* **bash:** correct off-by-one in truncated-line count ([#1786](https://github.com/Gitlawb/openclaude/issues/1786)) ([0b40000](https://github.com/Gitlawb/openclaude/commit/0b4000042ef4f8519ab0e161a54af293f650ed55))
* **bg:** preserve provider env-file values during prompt detection ([#1767](https://github.com/Gitlawb/openclaude/issues/1767)) ([6fdb1d0](https://github.com/Gitlawb/openclaude/commit/6fdb1d0c4631aa7ac9729edc8bd5cfc93f0fb522))
* **claude:** make stream watchdog deterministic ([#1823](https://github.com/Gitlawb/openclaude/issues/1823)) ([c1a9dad](https://github.com/Gitlawb/openclaude/commit/c1a9dadea532301f336f4f83e8180e5a1f0e5b07))
* **compaction:** make snip nudges model-aware ([#1816](https://github.com/Gitlawb/openclaude/issues/1816)) ([d0843be](https://github.com/Gitlawb/openclaude/commit/d0843bed0b099194b4adc47f2bc4a369b6c1554d))
* **compaction:** skip microcompact when compaction is off ([#1800](https://github.com/Gitlawb/openclaude/issues/1800)) ([320d63c](https://github.com/Gitlawb/openclaude/commit/320d63c812b9b76911b0f37dfc2cc9adf8487887))
* **copilot:** auto-refresh Copilot token on 401 instead of only showing re-auth hint ([#1766](https://github.com/Gitlawb/openclaude/issues/1766)) ([22fa5b4](https://github.com/Gitlawb/openclaude/commit/22fa5b42279e7f3020adeb6d79645eb956d14fa4))
* **core:** join multi-block message text with a real newline ([#1793](https://github.com/Gitlawb/openclaude/issues/1793)) ([4704cbc](https://github.com/Gitlawb/openclaude/commit/4704cbc474895e98c86a1f45df1ef563efcb76c0))
* **env-file:** collapse escaped backslashes in quoted values ([#1773](https://github.com/Gitlawb/openclaude/issues/1773)) ([82fd237](https://github.com/Gitlawb/openclaude/commit/82fd23798e0eb63a678659186a0cfc7c8c58b427))
* **hicap:** improve model catalog and effort routing ([#1790](https://github.com/Gitlawb/openclaude/issues/1790)) ([618e901](https://github.com/Gitlawb/openclaude/commit/618e901dd87fd714f601832cdeac0d8750c8a541))
* **moonshot:** Add verified Kimi effort metadata ([#1796](https://github.com/Gitlawb/openclaude/issues/1796)) ([13cf30a](https://github.com/Gitlawb/openclaude/commit/13cf30afa46933d72e1dce87124d4d4d16c79292))
* **ollama:** cap qwen3-coder-next:cloud output at 32768 ([#1814](https://github.com/Gitlawb/openclaude/issues/1814)) ([185ffea](https://github.com/Gitlawb/openclaude/commit/185ffea893f61b10ab0c8cfbff06f69baa7df5b6))
* **ollama:** preserve chat history with native context ([#1805](https://github.com/Gitlawb/openclaude/issues/1805)) ([259c7ec](https://github.com/Gitlawb/openclaude/commit/259c7ec27a1fc1bf5db39c23ce2544ccb0ccb588))
* **openai-shim:** recover GLM/Qwen XML tool calls emitted as text ([#1791](https://github.com/Gitlawb/openclaude/issues/1791)) ([2083d1c](https://github.com/Gitlawb/openclaude/commit/2083d1cdffb3240b854e0ada588b8101b6e6cc64))
* OpenClaude native launcher after Linux install ([#1798](https://github.com/Gitlawb/openclaude/issues/1798)) ([ab8645d](https://github.com/Gitlawb/openclaude/commit/ab8645da9fc855225259231f25cec19959a5347f))
* **plugins:** keep marketplace reconciliation prototype-safe ([#1821](https://github.com/Gitlawb/openclaude/issues/1821)) ([a7945e5](https://github.com/Gitlawb/openclaude/commit/a7945e5a70b875c636ed8bc013b897014adb74a4))
* **plugins:** treat prototype-shadowing marketplace names as not found ([#1787](https://github.com/Gitlawb/openclaude/issues/1787)) ([8859c5d](https://github.com/Gitlawb/openclaude/commit/8859c5d6e2a734f259c8c1792b26e865c6a5ad1a))
* **remote-session:** match ingress host by hostname, not raw substring ([#1792](https://github.com/Gitlawb/openclaude/issues/1792)) ([1cdca1c](https://github.com/Gitlawb/openclaude/commit/1cdca1cc7bcb1ca17203e81c9bee4325ec9c7b8c))
* **status-line:** estimate usage for unsupported providers ([#1803](https://github.com/Gitlawb/openclaude/issues/1803)) ([ff8d47d](https://github.com/Gitlawb/openclaude/commit/ff8d47d6c5bd0ca2f4a8d995197e604f91548275))
* **xAI:** Update xAI model metadata and effort handling ([#1795](https://github.com/Gitlawb/openclaude/issues/1795)) ([6f794f4](https://github.com/Gitlawb/openclaude/commit/6f794f4185116e4b1423031705b277e7df34b9a5))


### Performance Improvements

* **build:** minify the CLI bundle (whitespace + syntax, keep identifiers) ([#1743](https://github.com/Gitlawb/openclaude/issues/1743)) ([a723540](https://github.com/Gitlawb/openclaude/commit/a723540163060afce8657938a38c20b0968aee1f))
* **integrations:** load descriptor catalog lazily on first registry read ([#1742](https://github.com/Gitlawb/openclaude/issues/1742)) ([a1a3cfc](https://github.com/Gitlawb/openclaude/commit/a1a3cfc31ec3b16b9961afb4a6040bca966f66e8))
* **repl:** batch streaming text, cache normalize, coalesce config writes ([#1744](https://github.com/Gitlawb/openclaude/issues/1744)) ([13f7401](https://github.com/Gitlawb/openclaude/commit/13f740154117a9227fd22c3f229ec693576ace36))

## [0.20.1](https://github.com/Gitlawb/openclaude/compare/v0.20.0...v0.20.1) (2026-06-25)


### Bug Fixes

* **bg:** stream session logs with bounded memory ([#1762](https://github.com/Gitlawb/openclaude/issues/1762)) ([bd00b3b](https://github.com/Gitlawb/openclaude/commit/bd00b3b3c5bfb1bc3a0e46ac5296013c6b9d1eef))
* **bridge:** match loopback hostname exactly in HTTPS credential guard ([#1760](https://github.com/Gitlawb/openclaude/issues/1760)) ([66ddbec](https://github.com/Gitlawb/openclaude/commit/66ddbece19ed2b9735c7e6501c3cfbba4181ca75))
* **memory:** bound memory-directory scanning work ([#1757](https://github.com/Gitlawb/openclaude/issues/1757)) ([28bbec4](https://github.com/Gitlawb/openclaude/commit/28bbec49481ba625fda57d99418dbc50f67e30a2))
* **permissions:** bound the speculativeChecks cache with FIFO eviction ([#1724](https://github.com/Gitlawb/openclaude/issues/1724)) ([adcf5e5](https://github.com/Gitlawb/openclaude/commit/adcf5e5839edfd86595b7c75e09ba52e84d04588))
* prevent recursive debounce infinite loop in team memory sync ([#1726](https://github.com/Gitlawb/openclaude/issues/1726)) ([669ecdf](https://github.com/Gitlawb/openclaude/commit/669ecdfa8b3606ee347cfd85aafedb3a305b227a))
* **query:** prevent spurious Windows interruption prompt by passing 'interrupt' reason ([#1733](https://github.com/Gitlawb/openclaude/issues/1733)) ([701b68c](https://github.com/Gitlawb/openclaude/commit/701b68c2153dc26b1fa5e723298b51db496ea361))
* **resume:** tolerate malformed legacy attachment records ([#1768](https://github.com/Gitlawb/openclaude/issues/1768)) ([db66f41](https://github.com/Gitlawb/openclaude/commit/db66f41071cce118eaffc301e392b4576d07ff5b))
* surface swallowed error in plan file write ([#1725](https://github.com/Gitlawb/openclaude/issues/1725)) ([02d43b6](https://github.com/Gitlawb/openclaude/commit/02d43b69426eddf9a5f5a8478407223b44cf2a15))
* **update:** stop false "development build" block on npm installs with NODE_ENV=development ([#1781](https://github.com/Gitlawb/openclaude/issues/1781)) ([d32b6f0](https://github.com/Gitlawb/openclaude/commit/d32b6f04765afeec9e9ca858b37df4c9d4435ef5))
* **worktree:** base agent isolation worktree on parent HEAD, not origin/main ([#1652](https://github.com/Gitlawb/openclaude/issues/1652)) ([3fb718f](https://github.com/Gitlawb/openclaude/commit/3fb718f403aa3490c4d663797d38685b3074b528))

## [0.20.0](https://github.com/Gitlawb/openclaude/compare/v0.19.0...v0.20.0) (2026-06-24)


### Features

* Add session replay timeline ([#1705](https://github.com/Gitlawb/openclaude/issues/1705)) ([1be9b86](https://github.com/Gitlawb/openclaude/commit/1be9b86607c052163a134aae289aafd2c96153fc))
* **agent-routing:** assign a per-agent model from the /agents menu ([#1632](https://github.com/Gitlawb/openclaude/issues/1632)) ([5471e4c](https://github.com/Gitlawb/openclaude/commit/5471e4c453034c0cbcd1d17f61cdcd1f8b72d53d))
* **api:** add OpenAI-compatible credential pool failover ([#1706](https://github.com/Gitlawb/openclaude/issues/1706)) ([dd4c4ab](https://github.com/Gitlawb/openclaude/commit/dd4c4abc8119592464f5b7b2505a96bc4447f655))
* **atlas-cloud:** add GLM 5.2 to vendor catalog ([#1755](https://github.com/Gitlawb/openclaude/issues/1755)) ([c2467ee](https://github.com/Gitlawb/openclaude/commit/c2467eedad1d41b5d4d8cfac70ec38a1aa66ad43))
* auto-detect and persist project conventions to wiki ([#1010](https://github.com/Gitlawb/openclaude/issues/1010)) ([dc6a778](https://github.com/Gitlawb/openclaude/commit/dc6a7781bf8b73b0c18cb6ebb4c2751f8dc86dc8))
* **bughunter:** make /bughunter public + add /bughunter-security & /bughunter-perf with robust fallback prompts ([#1621](https://github.com/Gitlawb/openclaude/issues/1621)) ([1aabe26](https://github.com/Gitlawb/openclaude/commit/1aabe261dbb4e49c4dff995b8b5a62456f9607e1))
* **cache:** classify prompt-cache breaks by reliability ([#1693](https://github.com/Gitlawb/openclaude/issues/1693)) ([4cf9812](https://github.com/Gitlawb/openclaude/commit/4cf981200fd881d839a7872cfb4f342232eeaa37))
* **cli:** add local background sessions ([#1642](https://github.com/Gitlawb/openclaude/issues/1642)) ([a1b3346](https://github.com/Gitlawb/openclaude/commit/a1b3346f654d06f97aeec102394e0786bf8934ba))
* **commands:** add /update command with package-manager auto-detection ([#1687](https://github.com/Gitlawb/openclaude/issues/1687)) ([c4aa756](https://github.com/Gitlawb/openclaude/commit/c4aa7566899132effd798766a80b772fe01c4d2a))
* **config:** add explicit provider env-file loading ([#1668](https://github.com/Gitlawb/openclaude/issues/1668)) ([5af6f95](https://github.com/Gitlawb/openclaude/commit/5af6f95c46ebe994dc892177c956e4fdd9466426))
* **config:** add OPENCLAUDE_CONFIG_DIR override ([#1683](https://github.com/Gitlawb/openclaude/issues/1683)) ([2aad6fc](https://github.com/Gitlawb/openclaude/commit/2aad6fc93eeb93f668af87a88a02f5930a3fdc25))
* **context-collapse:** opt-in between-turns context collapse (span summarization) ([#1619](https://github.com/Gitlawb/openclaude/issues/1619)) ([d5588ea](https://github.com/Gitlawb/openclaude/commit/d5588ea80da55392ce79865448cb86b10778b6be))
* **fireworks:** add GLM-5.2 model support ([#1728](https://github.com/Gitlawb/openclaude/issues/1728)) ([ae66c30](https://github.com/Gitlawb/openclaude/commit/ae66c30df55665282ebc244142c0b0d6b4f28083))
* **integrations:** add GLM 5.2 as an Opengateway-routed model ([#1772](https://github.com/Gitlawb/openclaude/issues/1772)) ([adafde3](https://github.com/Gitlawb/openclaude/commit/adafde30fa9330404d89cedb731bade075d28d95))
* **memory:** add memory.autoWrite alias for autoMemoryEnabled ([#1326](https://github.com/Gitlawb/openclaude/issues/1326)) ([#1396](https://github.com/Gitlawb/openclaude/issues/1396)) ([b8c7c3b](https://github.com/Gitlawb/openclaude/commit/b8c7c3bfac48140bbe495ba8b54d356c1bb13abd))
* **permissions:** allow npm/bun/tsc --version as read-only ([#1759](https://github.com/Gitlawb/openclaude/issues/1759)) ([bcf9421](https://github.com/Gitlawb/openclaude/commit/bcf9421824c1e73bacdb5b2894e6bcc505cbd86b))
* **query:** add lifecycle identity and terminal reasons ([#1682](https://github.com/Gitlawb/openclaude/issues/1682)) ([23bc49a](https://github.com/Gitlawb/openclaude/commit/23bc49a01df40308bb2e863b74be57363dd36f2b))
* **ux:** long-turn visibility + default-on stream hang safety net ([#1758](https://github.com/Gitlawb/openclaude/issues/1758)) ([4dee44a](https://github.com/Gitlawb/openclaude/commit/4dee44a54288d8c1f91fb6fa8c138cd6195fe32b))
* **zai:** add GLM-5.2 support ([#1689](https://github.com/Gitlawb/openclaude/issues/1689)) ([b581bd9](https://github.com/Gitlawb/openclaude/commit/b581bd9eceb7dea7edfdcd65f1caf23707cb0365))


### Bug Fixes

* **atlas-cloud:** sync static catalog with live /models metadata ([#1754](https://github.com/Gitlawb/openclaude/issues/1754)) ([a23014b](https://github.com/Gitlawb/openclaude/commit/a23014b26084b84ef6a9a1434910e6751db6468f))
* **bg:** prefer exact session names over ID prefixes ([#1753](https://github.com/Gitlawb/openclaude/issues/1753)) ([820015f](https://github.com/Gitlawb/openclaude/commit/820015fbaf003265d93d99b507836b3b223be6bd))
* **bughunter-security:** align log-forging exclusion with A9 criteria ([1aabe26](https://github.com/Gitlawb/openclaude/commit/1aabe261dbb4e49c4dff995b8b5a62456f9607e1))
* **claude-desktop:** add native Windows support for MCP server import ([#1653](https://github.com/Gitlawb/openclaude/issues/1653)) ([e733908](https://github.com/Gitlawb/openclaude/commit/e733908a910bb9a1af4ba507c48109d8926b9031))
* **code-indexing:** guard command detection against prototype-chain names ([#1710](https://github.com/Gitlawb/openclaude/issues/1710)) ([059ec5e](https://github.com/Gitlawb/openclaude/commit/059ec5e8b04fc1642dda98b23a59ecfa4c969474))
* **context:** treat Opus 4.7 as 1M-context capable in modelSupports1M ([#1670](https://github.com/Gitlawb/openclaude/issues/1670)) ([de6b6bd](https://github.com/Gitlawb/openclaude/commit/de6b6bdd0357c7a3c9841e9422b65af4731b7bb7))
* **deps:** remove deprecated uuid install path by replacing vertex-sdk with local client ([#1771](https://github.com/Gitlawb/openclaude/issues/1771)) ([9c0d5c6](https://github.com/Gitlawb/openclaude/commit/9c0d5c61e2a436aa480d22f400ad7275acdee9fc))
* **format:** roll formatFileSize over to the next unit at the 1024 boundary ([#1703](https://github.com/Gitlawb/openclaude/issues/1703)) ([f5041e4](https://github.com/Gitlawb/openclaude/commit/f5041e4d46e8324b59d5aa6bd56de3851f57d3ff))
* **frontmatter:** expand nested brace globs in paths: correctly ([#1701](https://github.com/Gitlawb/openclaude/issues/1701)) ([ba85aa6](https://github.com/Gitlawb/openclaude/commit/ba85aa6dd0af8eb2beab82f366fee9afbdfe50de))
* **grep:** relativize content-mode paths correctly on Windows ([#1704](https://github.com/Gitlawb/openclaude/issues/1704)) ([4aec353](https://github.com/Gitlawb/openclaude/commit/4aec353f9cd2576cc51e9e5f635c800a461568f3))
* **ink:** reduce high-write-ratio diagnostic noise ([#1699](https://github.com/Gitlawb/openclaude/issues/1699)) ([cc385a6](https://github.com/Gitlawb/openclaude/commit/cc385a649092d2e7e0df0a441da7090d90c26638))
* **lsp:** throttle diagnostic storms ([#1698](https://github.com/Gitlawb/openclaude/issues/1698)) ([8cd4633](https://github.com/Gitlawb/openclaude/commit/8cd463383d832162c00f2e91961f3b509166c2b1))
* **mcp:** support draft 2020-12 tool schemas ([#1740](https://github.com/Gitlawb/openclaude/issues/1740)) ([ab94a50](https://github.com/Gitlawb/openclaude/commit/ab94a50a1a849ab45a27a85f94d11ac13573bc9b))
* **messages:** make projections tool-pair safe ([#1695](https://github.com/Gitlawb/openclaude/issues/1695)) ([df986c9](https://github.com/Gitlawb/openclaude/commit/df986c9275c30504b532cba17475ef60aa738a90))
* **model:** preserve [1m] tag for the 'best' alias ([#1671](https://github.com/Gitlawb/openclaude/issues/1671)) ([da551e6](https://github.com/Gitlawb/openclaude/commit/da551e6d05273e1ec6aa2c823c6d69738242e73c))
* **model:** preserve [1m] tag for the codex aliases ([#1709](https://github.com/Gitlawb/openclaude/issues/1709)) ([6c7d147](https://github.com/Gitlawb/openclaude/commit/6c7d14738740e0b3264fa0da617b55ce5dfd5340))
* **opencode-go:** sync model catalog with opencode.ai/go ([#1745](https://github.com/Gitlawb/openclaude/issues/1745)) ([38b0e27](https://github.com/Gitlawb/openclaude/commit/38b0e273334c98c67016ce8fdd3f1df319411299))
* preserve provider route context metadata ([#1741](https://github.com/Gitlawb/openclaude/issues/1741)) ([5625f42](https://github.com/Gitlawb/openclaude/commit/5625f4217df00eeec79d4629b21da175f9267a7e))
* **provider:** Add Xiaomi MiMo token plan provider ([#1751](https://github.com/Gitlawb/openclaude/issues/1751)) ([091571f](https://github.com/Gitlawb/openclaude/commit/091571f643b5ddaf060d397342f93b00271b3e40))
* **provider:** centralize provider secret redaction ([#1665](https://github.com/Gitlawb/openclaude/issues/1665)) ([29aea49](https://github.com/Gitlawb/openclaude/commit/29aea4969d0686f9864bbe88b030f79890d745c4))
* **provider:** honor explicit CLAUDE_CODE_USE_OPENAI=0 on fresh startup ([#1690](https://github.com/Gitlawb/openclaude/issues/1690)) ([6fbbf2d](https://github.com/Gitlawb/openclaude/commit/6fbbf2dffce6efbbb130ebcb69a1d22cbd727c16)), closes [#1245](https://github.com/Gitlawb/openclaude/issues/1245)
* **provider:** match xAI base URL by hostname, not 'x.ai' substring ([#1669](https://github.com/Gitlawb/openclaude/issues/1669)) ([1b33fa6](https://github.com/Gitlawb/openclaude/commit/1b33fa62b841aa0a0230d685957925598e2edecf))
* **query:** add activity-aware query guard leases ([#1686](https://github.com/Gitlawb/openclaude/issues/1686)) ([23cfc24](https://github.com/Gitlawb/openclaude/commit/23cfc242ed465de22ddc8b54952b1bbf04cef785))
* **sdk:** make stub-leak detection TDZ-safe + defer to next microtask ([#1287](https://github.com/Gitlawb/openclaude/issues/1287)) ([#1398](https://github.com/Gitlawb/openclaude/issues/1398)) ([650fae9](https://github.com/Gitlawb/openclaude/commit/650fae952d2b4c22fb5216121f18ba613e4191f5))
* **session-title:** harden generated title handling ([#1691](https://github.com/Gitlawb/openclaude/issues/1691)) ([beab67b](https://github.com/Gitlawb/openclaude/commit/beab67b44a9796a6c3d75ba455bc8a20d08f6e76))
* **settings:** correct stale settings path references ([#1666](https://github.com/Gitlawb/openclaude/issues/1666)) ([544b857](https://github.com/Gitlawb/openclaude/commit/544b857876acc180a2ef4fa543a3117aefb861d4))
* **status:** show active provider route instead of legacy provider bucket ([#1673](https://github.com/Gitlawb/openclaude/issues/1673)) ([b9a5030](https://github.com/Gitlawb/openclaude/commit/b9a5030b672de6081ef855dd5e45e5216c9a8f11))
* treat 5xx HTML overload pages as retryable provider_unavailable ([#1750](https://github.com/Gitlawb/openclaude/issues/1750)) ([aed42df](https://github.com/Gitlawb/openclaude/commit/aed42df19bed70db0242f70d8a6e5b84a22f934e))
* type safety, defensive defaults, and unbounded retry prevention ([#1553](https://github.com/Gitlawb/openclaude/issues/1553)) ([02ee7c6](https://github.com/Gitlawb/openclaude/commit/02ee7c63e9fe9cbdd82c64b4a011db5811f63114))
* upgrade shell-quote 1.8.3 -&gt; 1.8.4 (CVE-2026-9277) ([#1764](https://github.com/Gitlawb/openclaude/issues/1764)) ([3eb57c6](https://github.com/Gitlawb/openclaude/commit/3eb57c6d134d5e15a3c0049265860acc794bd17a))
* **warnings:** surface perf hooks buffer guidance ([#1696](https://github.com/Gitlawb/openclaude/issues/1696)) ([916f247](https://github.com/Gitlawb/openclaude/commit/916f2477f3e371b97097198fe9f3388bded716ec))
* WSL stdin handling ([#1679](https://github.com/Gitlawb/openclaude/issues/1679)) ([3135e73](https://github.com/Gitlawb/openclaude/commit/3135e731c9f21c5485bb41ac0788f62a6c8e8145))


### Performance Improvements

* eliminate response.clone() memory doubling and cache lazy tool getters ([#1478](https://github.com/Gitlawb/openclaude/issues/1478)) ([7d130e7](https://github.com/Gitlawb/openclaude/commit/7d130e73ba0aa30caf99d65e6139e269a910f837))

## [0.19.0](https://github.com/Gitlawb/openclaude/compare/v0.18.0...v0.19.0) (2026-06-16)


### Features

* add NEAR AI provider integration ([#1594](https://github.com/Gitlawb/openclaude/issues/1594)) ([eacc7d8](https://github.com/Gitlawb/openclaude/commit/eacc7d8facc6e94acacc58ec205f377681107c50))
* add redacted diagnostic issue reports ([#1647](https://github.com/Gitlawb/openclaude/issues/1647)) ([7c034c5](https://github.com/Gitlawb/openclaude/commit/7c034c5a62a972efb9c0d4fdb1ff1bd1dea2168f))
* add Vietnamese i18n for slash command descriptions ([#1431](https://github.com/Gitlawb/openclaude/issues/1431)) ([89d0531](https://github.com/Gitlawb/openclaude/commit/89d05317b6b6f6c45008ff7074e74a3638d3246b))
* **agent-routing:** model-only agent routes (set the verifier or any agent's model on the current provider) ([#1617](https://github.com/Gitlawb/openclaude/issues/1617)) ([9e902db](https://github.com/Gitlawb/openclaude/commit/9e902db86617aba657235b5687a47080173e4bbf))
* **compact:** auto-compact prompt on /resume + determinate progress bar ([#1386](https://github.com/Gitlawb/openclaude/issues/1386)) ([716c1d4](https://github.com/Gitlawb/openclaude/commit/716c1d47f68349f5f5f151090292d2544cf83cf9))
* **config:** add compactModel option to use a separate model for compaction ([#1445](https://github.com/Gitlawb/openclaude/issues/1445)) ([#1629](https://github.com/Gitlawb/openclaude/issues/1629)) ([0c45e16](https://github.com/Gitlawb/openclaude/commit/0c45e16f189487955caec7861f00d0eb5d4c5341))
* **ctx:** add /ctx context window visualization and token bars to /cost ([#1610](https://github.com/Gitlawb/openclaude/issues/1610)) ([c2cf603](https://github.com/Gitlawb/openclaude/commit/c2cf60334421736a0e1f183ae0f8ff766ad4ecdf))
* **gemini-vertex:** native Gemini Vertex client and auth helpers (1/3) ([#1607](https://github.com/Gitlawb/openclaude/issues/1607)) ([b9c65de](https://github.com/Gitlawb/openclaude/commit/b9c65deabc00d7bdc622c8d30087f2702c8910f1))
* **provider:** add Fireworks AI as official OpenAI-compatible provider ([#1590](https://github.com/Gitlawb/openclaude/issues/1590)) ([0b24b60](https://github.com/Gitlawb/openclaude/commit/0b24b60ce92a108ab062c1a78ce101d4f951c45c))
* **web:** rebuild landing as Astro static site with gitlawb theme and full docs ([#1606](https://github.com/Gitlawb/openclaude/issues/1606)) ([d08593d](https://github.com/Gitlawb/openclaude/commit/d08593de922891bff954985d716e9a906d01538e))


### Bug Fixes

* avoid file suggestion OOM on large repos ([#1074](https://github.com/Gitlawb/openclaude/issues/1074)) ([8f92346](https://github.com/Gitlawb/openclaude/commit/8f92346cf403f41a2176e408b93a814da8c0fd79))
* **copilot:** limit sub-agent concurrency to reduce Premium Request usage ([#678](https://github.com/Gitlawb/openclaude/issues/678)) ([#1534](https://github.com/Gitlawb/openclaude/issues/1534)) ([822eff3](https://github.com/Gitlawb/openclaude/commit/822eff39d1707455f9b0723ff2761f8c412b56a5))
* **gitDiff:** keep hunk content lines beginning with -- or ++ ([#1646](https://github.com/Gitlawb/openclaude/issues/1646)) ([241d52a](https://github.com/Gitlawb/openclaude/commit/241d52af47d179b1042227c176ba44fc6ae4c83f))
* **mcp:** demote successful stdio startup stderr ([#1622](https://github.com/Gitlawb/openclaude/issues/1622)) ([9fbcd75](https://github.com/Gitlawb/openclaude/commit/9fbcd755a3a1b731c63db3034401905133eb83a1))
* Ollama max output token override ([#1659](https://github.com/Gitlawb/openclaude/issues/1659)) ([bac74aa](https://github.com/Gitlawb/openclaude/commit/bac74aafee2c35b4126a07460291f9cba7413e31))
* **ollama:** parse text-based tool calls as fallback ([#1053](https://github.com/Gitlawb/openclaude/issues/1053)) ([#1076](https://github.com/Gitlawb/openclaude/issues/1076)) ([a3f144b](https://github.com/Gitlawb/openclaude/commit/a3f144bbf26be5c7676e9a2f79a747186867f021))
* **plugins:** prevent ENOENT on Windows marketplace cache finalization ([#1500](https://github.com/Gitlawb/openclaude/issues/1500)) ([#1531](https://github.com/Gitlawb/openclaude/issues/1531)) ([a7d6580](https://github.com/Gitlawb/openclaude/commit/a7d65805213b92d3f6eceb46c0c0cc2ffa9dcb01))
* **read:** improve oversized file guidance ([#1626](https://github.com/Gitlawb/openclaude/issues/1626)) ([5fd4a09](https://github.com/Gitlawb/openclaude/commit/5fd4a09d0193431aaed07af2c56351a805db365b))
* rename "Claude" to "OpenClaude" in feedback survey prompt ([#1598](https://github.com/Gitlawb/openclaude/issues/1598)) ([d00b105](https://github.com/Gitlawb/openclaude/commit/d00b1050f5acd07b12fc49bcb4802ab446fef27a))
* sandbox temp dir fallback ([#1662](https://github.com/Gitlawb/openclaude/issues/1662)) ([c3db798](https://github.com/Gitlawb/openclaude/commit/c3db79832bc0c35fb3ba6f652c81106bfe274d39))
* **security:** bundle real sandbox runtime in open CLI ([#1641](https://github.com/Gitlawb/openclaude/issues/1641)) ([bd3ad89](https://github.com/Gitlawb/openclaude/commit/bd3ad89dd788e6efa4b8b9df6a36d841005eee52))
* **session:** filter Anthropic-only params from 3P provider requests ([#248](https://github.com/Gitlawb/openclaude/issues/248)) ([#1533](https://github.com/Gitlawb/openclaude/issues/1533)) ([db2d093](https://github.com/Gitlawb/openclaude/commit/db2d093af3a0ad0dc5fc1b546faa44e56800362f))
* startup provider validation fallback ([#1658](https://github.com/Gitlawb/openclaude/issues/1658)) ([b036e9f](https://github.com/Gitlawb/openclaude/commit/b036e9fa7c5a82b2d01e6b7435109caa36027aa0))
* **suggestions:** stop slash-command dropdown freezing on a throwing getter ([#1657](https://github.com/Gitlawb/openclaude/issues/1657)) ([00ff6de](https://github.com/Gitlawb/openclaude/commit/00ff6de4cacddaa50b9875366e9b5dd4fa7d101f))
* **tool-search:** enable MCP tool deferral on converted-wire providers ([#1608](https://github.com/Gitlawb/openclaude/issues/1608)) ([614a8d9](https://github.com/Gitlawb/openclaude/commit/614a8d9c54fbe3b15c2a907f8de4ad00fa3a3d10))
* **typecheck:** correct fetch mock type casts in test files ([#1592](https://github.com/Gitlawb/openclaude/issues/1592)) ([794ccd4](https://github.com/Gitlawb/openclaude/commit/794ccd4f9e7d96d1eac9e28f97f04e09caf4f8b6))
* **typecheck:** expand cachedMicrocompact stub exports ([#1591](https://github.com/Gitlawb/openclaude/issues/1591)) ([bb19392](https://github.com/Gitlawb/openclaude/commit/bb19392e699a531e8f4b6c8dad3bebbcd2454a51))
* **typecheck:** recreate missing CLI Transport interface ([#1581](https://github.com/Gitlawb/openclaude/issues/1581)) ([3752dfe](https://github.com/Gitlawb/openclaude/commit/3752dfe6f7165285951f2cc534f2a8a01e31a319))
* **typecheck:** reduce error baseline by 89 across 8 files ([#1595](https://github.com/Gitlawb/openclaude/issues/1595)) ([9db9427](https://github.com/Gitlawb/openclaude/commit/9db9427f2961ff13a0d24c4f3261fd9ad5bfa932))
* vision handling for OpenAI-compatible models ([#1663](https://github.com/Gitlawb/openclaude/issues/1663)) ([7be9dce](https://github.com/Gitlawb/openclaude/commit/7be9dce8ef973a7290ef0621276af6d65abc0294))


### Performance Improvements

* **cli:** restore --version fast path with dynamic provider imports ([#1611](https://github.com/Gitlawb/openclaude/issues/1611)) ([a3a3c36](https://github.com/Gitlawb/openclaude/commit/a3a3c3659dbe6b51c3e4027b990bf77b6b020a1a))

## [0.18.0](https://github.com/Gitlawb/openclaude/compare/v0.17.1...v0.18.0) (2026-06-10)


### Features

* add .gitattributes to enforce LF line endings ([#1550](https://github.com/Gitlawb/openclaude/issues/1550)) ([1c27957](https://github.com/Gitlawb/openclaude/commit/1c279577f9b294dbb02f4b8859c60fcaeb840ca6))
* enable HISTORY_SNIP — model-callable snip tool for context management ([#1407](https://github.com/Gitlawb/openclaude/issues/1407)) ([cdc8057](https://github.com/Gitlawb/openclaude/commit/cdc8057496b43b38b62f738c20a2db72986c9683))
* extend --fallback-model to interactive REPL sessions ([#1346](https://github.com/Gitlawb/openclaude/issues/1346)) ([#1419](https://github.com/Gitlawb/openclaude/issues/1419)) ([14e5a41](https://github.com/Gitlawb/openclaude/commit/14e5a41acd7a0349c6c982e44e7f2650199ab971))
* **github:** expose all 21 Copilot models with context window metadata ([#822](https://github.com/Gitlawb/openclaude/issues/822)) ([#1535](https://github.com/Gitlawb/openclaude/issues/1535)) ([1e8c1ac](https://github.com/Gitlawb/openclaude/commit/1e8c1ac8f5c07e7456420e8269851ad0ccc4c1c1))
* **goal:** add session-scoped /goal continuation ([#1293](https://github.com/Gitlawb/openclaude/issues/1293)) ([102cc30](https://github.com/Gitlawb/openclaude/commit/102cc3060fd3fc32eee91c8c3f2df7fd0a9af9fa))
* **opengateway:** surface the gateway's "auto" smart-routing model in /model ([#1588](https://github.com/Gitlawb/openclaude/issues/1588)) ([5040c49](https://github.com/Gitlawb/openclaude/commit/5040c491daa87587f0a3cf10e693c65dd7d5a389))
* **provider:** add Atlas Cloud as official OpenAI-compatible provider ([#1585](https://github.com/Gitlawb/openclaude/issues/1585)) ([5b01c2b](https://github.com/Gitlawb/openclaude/commit/5b01c2b59533b5450f06c2e520b2d45c72930226))


### Bug Fixes

* add error context to silent catches and debugger detection ([#1479](https://github.com/Gitlawb/openclaude/issues/1479)) ([e9b211a](https://github.com/Gitlawb/openclaude/commit/e9b211a2262fc2d9b877c58683a66bdd885531b9))
* **agent-routing:** support API model aliases ([#1546](https://github.com/Gitlawb/openclaude/issues/1546)) ([9a342b6](https://github.com/Gitlawb/openclaude/commit/9a342b61fafce5908ac18f79275b70e51cae6ba4))
* **api:** honor OpenAI-compatible retry classification ([#1547](https://github.com/Gitlawb/openclaude/issues/1547)) ([f1013df](https://github.com/Gitlawb/openclaude/commit/f1013df81828eb1035c054e415ac16c9d84de917))
* **api:** retry once with provider-capped max_tokens ([#1235](https://github.com/Gitlawb/openclaude/issues/1235)) ([edabf33](https://github.com/Gitlawb/openclaude/commit/edabf33a337b700a1937ab453a7872806281beff))
* **claudemd:** gate User-scope external [@include](https://github.com/include) behind hasClaudeMdEx… ([#1223](https://github.com/Gitlawb/openclaude/issues/1223)) ([fde7aa0](https://github.com/Gitlawb/openclaude/commit/fde7aa07a0c83aaf8cf52be5ca93cb2e121cfb79))
* **context:** avoid noisy metadata fallback errors ([#1544](https://github.com/Gitlawb/openclaude/issues/1544)) ([12cbe92](https://github.com/Gitlawb/openclaude/commit/12cbe92344c8d1a8bf07834bcd4c9cbb4dadf665))
* **mcp:** fail-closed on token count error + respect maxChars budget ([#1113](https://github.com/Gitlawb/openclaude/issues/1113)) ([bd8c6b1](https://github.com/Gitlawb/openclaude/commit/bd8c6b1eb5798b8f76dc331222dbf81e99e1b74b))
* **mcp:** pass MCP stdio server args as separate array elements to pr… ([#1222](https://github.com/Gitlawb/openclaude/issues/1222)) ([0d4e247](https://github.com/Gitlawb/openclaude/commit/0d4e2479056238cff7656d43e66818e47daae038))
* **openai-shim:** guarantee reasoning_content continuity for DeepSeek… ([#1228](https://github.com/Gitlawb/openclaude/issues/1228)) ([d67c6d7](https://github.com/Gitlawb/openclaude/commit/d67c6d77d3c7ecd6cc6dd960ae6667afdb16ca02))
* **openai-shim:** include text for image-only user content ([#1410](https://github.com/Gitlawb/openclaude/issues/1410)) ([7c05453](https://github.com/Gitlawb/openclaude/commit/7c05453f7925c52dc006879c8eef9eda10d6a965))
* **provider:** preserve explicit startup env ([#1560](https://github.com/Gitlawb/openclaude/issues/1560)) ([754cb61](https://github.com/Gitlawb/openclaude/commit/754cb61d17f041df483d570050899089e08e6010))
* replace codex input_text with standard text type in generic resp ([#1449](https://github.com/Gitlawb/openclaude/issues/1449)) ([be05594](https://github.com/Gitlawb/openclaude/commit/be05594ce8adbbb202b193b39217e548c05abdc8))
* **typecheck:** add MCP component view types ([#1564](https://github.com/Gitlawb/openclaude/issues/1564)) ([548bffc](https://github.com/Gitlawb/openclaude/commit/548bffc2a77f14047f7558c0bce220fc67ab3ff8))
* **typecheck:** add missing type aliases to message and tools stubs ([#1510](https://github.com/Gitlawb/openclaude/issues/1510)) ([ea75a51](https://github.com/Gitlawb/openclaude/commit/ea75a51054cec75858a343ad7f4ba5ea47b579cb))
* **typecheck:** add missing xai entry to deprecation retirement date maps ([#1509](https://github.com/Gitlawb/openclaude/issues/1509)) ([1d90960](https://github.com/Gitlawb/openclaude/commit/1d90960afac36aa34b46bbbeca0884e420bbe57c)), closes [#1486](https://github.com/Gitlawb/openclaude/issues/1486)
* **typecheck:** add plugin command view types ([#1565](https://github.com/Gitlawb/openclaude/issues/1565)) ([fc0a4b5](https://github.com/Gitlawb/openclaude/commit/fc0a4b5cdf641b59cfda1759bc616269557309ac))
* **typecheck:** add proper type parameters to useState(null) hooks ([#1513](https://github.com/Gitlawb/openclaude/issues/1513)) ([0e30ee8](https://github.com/Gitlawb/openclaude/commit/0e30ee83a625e7f23e3c20838f65207c0b2d6581)), closes [#1486](https://github.com/Gitlawb/openclaude/issues/1486)
* **typecheck:** add wizard agent creation types ([#1566](https://github.com/Gitlawb/openclaude/issues/1566)) ([65034db](https://github.com/Gitlawb/openclaude/commit/65034db3679e170680b6e5d358a781e30ddc65fc))
* **typecheck:** annotate diff rendering props ([#1568](https://github.com/Gitlawb/openclaude/issues/1568)) ([e53d612](https://github.com/Gitlawb/openclaude/commit/e53d612da5ce77b543846256e130a80f0f8f116d))
* **typecheck:** declare bundled markdown and macro fields ([#1562](https://github.com/Gitlawb/openclaude/issues/1562)) ([5c239eb](https://github.com/Gitlawb/openclaude/commit/5c239eb6019949f0161a50999eaa00ddd3ed688b))
* **typecheck:** declare Ink JSX intrinsics ([#1571](https://github.com/Gitlawb/openclaude/issues/1571)) ([38b2d83](https://github.com/Gitlawb/openclaude/commit/38b2d836990ab97d04a906bd967441dafc017fe1))
* **typecheck:** declare optional native modules ([#1563](https://github.com/Gitlawb/openclaude/issues/1563)) ([f129dd0](https://github.com/Gitlawb/openclaude/commit/f129dd039758129d56d47c4e5adf6c87e86091b0))
* **typecheck:** import bun test helpers in truncate test ([#1520](https://github.com/Gitlawb/openclaude/issues/1520)) ([8527a04](https://github.com/Gitlawb/openclaude/commit/8527a04e9b7644dab1322f383383566e9c639e3f))
* **typecheck:** narrow remote agent SDK logs ([#1573](https://github.com/Gitlawb/openclaude/issues/1573)) ([7727a9f](https://github.com/Gitlawb/openclaude/commit/7727a9f3a3ab34468a33f44671cd56c78c1b298d))
* **typecheck:** recreate missing FeedbackSurvey utils ([#1580](https://github.com/Gitlawb/openclaude/issues/1580)) ([62c2c5b](https://github.com/Gitlawb/openclaude/commit/62c2c5b62f431013b1b6eb6ed632a6fc1a678c5d))
* **typecheck:** recreate missing Spinner types ([#1579](https://github.com/Gitlawb/openclaude/issues/1579)) ([553342c](https://github.com/Gitlawb/openclaude/commit/553342c204b2cc1fafdded7165b9b4e66ebea834))
* **typecheck:** replace dead-code literal comparisons with isAntEmployee() ([#1512](https://github.com/Gitlawb/openclaude/issues/1512)) ([7078853](https://github.com/Gitlawb/openclaude/commit/7078853ea8f5dca2686cf63e019bf047c861e554))
* **typecheck:** restore control protocol type exports ([#1497](https://github.com/Gitlawb/openclaude/issues/1497)) ([3a308c1](https://github.com/Gitlawb/openclaude/commit/3a308c11d44514e6262eb878511efca6d83bbcc7))
* **typecheck:** tighten permission rule UI types ([#1567](https://github.com/Gitlawb/openclaude/issues/1567)) ([6ee24f7](https://github.com/Gitlawb/openclaude/commit/6ee24f78e76fa3f68303561e96975fc25b03f6f5))
* **typecheck:** type beta header accumulator ([#1516](https://github.com/Gitlawb/openclaude/issues/1516)) ([a692fca](https://github.com/Gitlawb/openclaude/commit/a692fca02a0aedb013c0aef89b8972ef14d464f7))
* **typecheck:** type cache-busted credential tests ([#1525](https://github.com/Gitlawb/openclaude/issues/1525)) ([9e942da](https://github.com/Gitlawb/openclaude/commit/9e942da3fbf02816d3113a93988a7ac1cced8174))
* **typecheck:** type Doctor screen state ([#1522](https://github.com/Gitlawb/openclaude/issues/1522)) ([6cb3493](https://github.com/Gitlawb/openclaude/commit/6cb3493d8c5f4ad862d17af9d427bdf69cafebd5))
* **typecheck:** type FileWrite rejection state ([#1574](https://github.com/Gitlawb/openclaude/issues/1574)) ([fba949c](https://github.com/Gitlawb/openclaude/commit/fba949cabf48a9bc352f6c91ad7fe61946bdca32))
* **typecheck:** type Grove dialog state ([#1521](https://github.com/Gitlawb/openclaude/issues/1521)) ([f726685](https://github.com/Gitlawb/openclaude/commit/f726685ff0172800a530ef317962270513926b58))
* **typecheck:** type gRPC stream messages ([#1572](https://github.com/Gitlawb/openclaude/issues/1572)) ([c2cc6ed](https://github.com/Gitlawb/openclaude/commit/c2cc6ed333ba4c095709ae804b0fb222987b6f20))
* **typecheck:** type MCP doctor test fixtures ([#1527](https://github.com/Gitlawb/openclaude/issues/1527)) ([38c0fe4](https://github.com/Gitlawb/openclaude/commit/38c0fe4982cb8e1e387efd69eae7da8f2cd49336))
* **typecheck:** type MCP XAA auth storage ([#1570](https://github.com/Gitlawb/openclaude/issues/1570)) ([bf2d540](https://github.com/Gitlawb/openclaude/commit/bf2d540efc5e7369c8d8466dcb3605608578b9d9))
* **typecheck:** type provider diagnostic tests ([#1517](https://github.com/Gitlawb/openclaude/issues/1517)) ([ebf38f7](https://github.com/Gitlawb/openclaude/commit/ebf38f7819a5c2ba1bf1b5ef7d9f2c1d58d3dc59))
* **typecheck:** type secure storage command output ([#1524](https://github.com/Gitlawb/openclaude/issues/1524)) ([8c2f585](https://github.com/Gitlawb/openclaude/commit/8c2f5859b3c63dd7a2569088877fc31a3ba8b396))
* **typecheck:** type session storage test fixtures ([#1526](https://github.com/Gitlawb/openclaude/issues/1526)) ([491985a](https://github.com/Gitlawb/openclaude/commit/491985a6181a43cb616944ca23144024b86a9ea3))
* **typecheck:** type stats dialog state ([#1569](https://github.com/Gitlawb/openclaude/issues/1569)) ([499c702](https://github.com/Gitlawb/openclaude/commit/499c702bcec3789d59b1c4898e43b5b30d3720e2))
* **typecheck:** type tool test fixtures ([#1518](https://github.com/Gitlawb/openclaude/issues/1518)) ([ddf9282](https://github.com/Gitlawb/openclaude/commit/ddf9282ae31c072a821c909919118157897de054))


### Performance Improvements

* **attachments:** skip skill listings for utility forks ([#1545](https://github.com/Gitlawb/openclaude/issues/1545)) ([2bed184](https://github.com/Gitlawb/openclaude/commit/2bed1849b1a587bda2970cb83f20b326f794aec0))

## [0.17.1](https://github.com/Gitlawb/openclaude/compare/v0.17.0...v0.17.1) (2026-06-05)


### Bug Fixes

* **typecheck:** type GitHub app setup flow ([#1523](https://github.com/Gitlawb/openclaude/issues/1523)) ([80607ca](https://github.com/Gitlawb/openclaude/commit/80607ca1358991ca4d8025213c7c2e26748f2b93))
* **typecheck:** type search UI state ([#1529](https://github.com/Gitlawb/openclaude/issues/1529)) ([47eea3f](https://github.com/Gitlawb/openclaude/commit/47eea3f8b13c85865b84525563b4eaf446c91b6c))

## [0.17.0](https://github.com/Gitlawb/openclaude/compare/v0.16.1...v0.17.0) (2026-06-05)


### Features

* add conversation cache and session persistence ([#705](https://github.com/Gitlawb/openclaude/issues/705)) ([353e306](https://github.com/Gitlawb/openclaude/commit/353e3060644254c331b52fe9d243f97b78c570fe))
* memory optimization to prevent OOM in multi-session scenarios ([#1437](https://github.com/Gitlawb/openclaude/issues/1437)) ([22b1a19](https://github.com/Gitlawb/openclaude/commit/22b1a193f1c34763a5f98c985fc98fccac0109fd))
* **minimax:** add MiniMax M3 model with 1M context window ([#1470](https://github.com/Gitlawb/openclaude/issues/1470)) ([e2fa248](https://github.com/Gitlawb/openclaude/commit/e2fa248376f5242dd01c22c173e1332593bc5b78))
* **nvidia-nim:** dynamic model discovery via integrate.api.nvidia.com ([#1099](https://github.com/Gitlawb/openclaude/issues/1099)) ([#1177](https://github.com/Gitlawb/openclaude/issues/1177)) ([890456b](https://github.com/Gitlawb/openclaude/commit/890456b35e1e6d6a4baf4febc27af610d3f4aaad))
* **opengateway:** add MiniMax M3 and Qwen 3.7 Max to the model catalog ([#1515](https://github.com/Gitlawb/openclaude/issues/1515)) ([8705cd3](https://github.com/Gitlawb/openclaude/commit/8705cd35f72c0804059c3ebbd85b1189f3ea9d07))
* **opengateway:** Gemini 3.1 Flash Lite GA model id ([#1537](https://github.com/Gitlawb/openclaude/issues/1537)) ([ea09176](https://github.com/Gitlawb/openclaude/commit/ea091768ae15e0676ec184b3df841239733e8d97))
* **provider:** auto-switch on rate limit via providerFallbackChain ([#768](https://github.com/Gitlawb/openclaude/issues/768)) ([#1176](https://github.com/Gitlawb/openclaude/issues/1176)) ([cfbce38](https://github.com/Gitlawb/openclaude/commit/cfbce38fe688717f61b48624ea0461cf2c1bb707))
* **sponsors:** add Atlas Cloud sponsor and sponsored tip ([#1536](https://github.com/Gitlawb/openclaude/issues/1536)) ([73a2833](https://github.com/Gitlawb/openclaude/commit/73a2833819aa6cea91871779d9ff2f11e0953e31))
* **xiaomi:** retire deprecated MiMo V2 Pro and V2 Omni ([#1538](https://github.com/Gitlawb/openclaude/issues/1538)) ([b1a8026](https://github.com/Gitlawb/openclaude/commit/b1a80267a5ed108b3700df08e051419d5a2c6fab))


### Bug Fixes

* **api:** tighten reasoning_content heuristic to prevent false-positi… ([#1201](https://github.com/Gitlawb/openclaude/issues/1201)) ([1fc5116](https://github.com/Gitlawb/openclaude/commit/1fc5116e9551948de0d47ea20bdfbd73631dee18))
* **BashTool:** include captured output in non-zero-exit error result ([#1231](https://github.com/Gitlawb/openclaude/issues/1231)) ([#1249](https://github.com/Gitlawb/openclaude/issues/1249)) ([8416faa](https://github.com/Gitlawb/openclaude/commit/8416faa75c1baae5b079e9f4dd7a624a7f6fb6ff))
* **cron:** enforce MAX_CRON_PROMPT_CHARS cap on durable cron prompt l… ([#1224](https://github.com/Gitlawb/openclaude/issues/1224)) ([f7d42c2](https://github.com/Gitlawb/openclaude/commit/f7d42c2b70081f0943cf5ebe08ab0d396cda4b99))
* **plugins:** use mergeHooksSettings in marketplace supplement path ([#1055](https://github.com/Gitlawb/openclaude/issues/1055)) ([#1167](https://github.com/Gitlawb/openclaude/issues/1167)) ([a7fc408](https://github.com/Gitlawb/openclaude/commit/a7fc408779dc6580da8f5a05dee4bcef03ad1446))
* preserve raw mode across component re-renders (issue [#843](https://github.com/Gitlawb/openclaude/issues/843)) ([#1198](https://github.com/Gitlawb/openclaude/issues/1198)) ([3bf6ccd](https://github.com/Gitlawb/openclaude/commit/3bf6ccd6d8f5bc8c1893c2b6fdceec86e084eac1))
* **promptinput:** keep bash-mode `!` out of the local mirror ([#1179](https://github.com/Gitlawb/openclaude/issues/1179)) ([#1182](https://github.com/Gitlawb/openclaude/issues/1182)) ([ad3e208](https://github.com/Gitlawb/openclaude/commit/ad3e2085927f620adf05fa02f81f59d1c17c0d68))
* **security:** prevent CRLF injection, path injection, and error message leakage ([#1477](https://github.com/Gitlawb/openclaude/issues/1477)) ([7278cad](https://github.com/Gitlawb/openclaude/commit/7278cad872dcaca49bb9b4410d00538004dfcf49))
* show all configured Mistral models and fix model selection priority ([#1360](https://github.com/Gitlawb/openclaude/issues/1360)) ([#1418](https://github.com/Gitlawb/openclaude/issues/1418)) ([7df7cad](https://github.com/Gitlawb/openclaude/commit/7df7cad33345d2724cbff88e68a51c9dac26f306))
* show vision-specific error when provider returns 404 for image requests ([#1187](https://github.com/Gitlawb/openclaude/issues/1187)) ([8801a4c](https://github.com/Gitlawb/openclaude/commit/8801a4cd644d3e9ac1e8f91256307f7ee891172e))
* **test:** stop use-input test from leaking a global stdin mock ([#1501](https://github.com/Gitlawb/openclaude/issues/1501)) ([96ddec7](https://github.com/Gitlawb/openclaude/commit/96ddec71835dab350a5f6de399e819d8060c60c9))
* **typecheck:** make session history cache variant-safe ([#1494](https://github.com/Gitlawb/openclaude/issues/1494)) ([e7abb81](https://github.com/Gitlawb/openclaude/commit/e7abb8146f9d8841c3e59aff7f4dd066ced3851b))
* **typecheck:** narrow hook event counts ([#1496](https://github.com/Gitlawb/openclaude/issues/1496)) ([11e46af](https://github.com/Gitlawb/openclaude/commit/11e46affd10ab3412e1617aca08aed182bb3328d))
* **typecheck:** restore AppState hook generics ([#1503](https://github.com/Gitlawb/openclaude/issues/1503)) ([343cd1a](https://github.com/Gitlawb/openclaude/commit/343cd1a2c93208429d9e02817aafea996ab19117))
* **typecheck:** restore proactive module import surface ([#1495](https://github.com/Gitlawb/openclaude/issues/1495)) ([e357d59](https://github.com/Gitlawb/openclaude/commit/e357d593e0b90584aec0ec83f3adf5c845487a4a))
* **typecheck:** restore typed add-dir source ([#1504](https://github.com/Gitlawb/openclaude/issues/1504)) ([2c755d3](https://github.com/Gitlawb/openclaude/commit/2c755d3da83ab1b48dfb5d5c048a682ae1325a77))
* use mistral-vibe-cli-latest as default model for Mistral AI ([#1188](https://github.com/Gitlawb/openclaude/issues/1188)) ([671faf2](https://github.com/Gitlawb/openclaude/commit/671faf23ab4d34383bc6f3b62ce4d0363d0f216b))
* **vscode:** send schema-valid permission responses ([#1401](https://github.com/Gitlawb/openclaude/issues/1401)) ([8065f8d](https://github.com/Gitlawb/openclaude/commit/8065f8d37b2cdfafe0833288e9150ff3af5ba2af))

## [0.16.1](https://github.com/Gitlawb/openclaude/compare/v0.16.0...v0.16.1) (2026-06-01)


### Bug Fixes

* **ci:** build before unit tests in release workflow ([#1463](https://github.com/Gitlawb/openclaude/issues/1463)) ([d35d468](https://github.com/Gitlawb/openclaude/commit/d35d4687ad33388f87f43652919ce3ea96dd7435))

## [0.16.0](https://github.com/Gitlawb/openclaude/compare/v0.15.0...v0.16.0) (2026-05-31)


### Features

* **doctor:** warn local-model users about large context contributors ([#1238](https://github.com/Gitlawb/openclaude/issues/1238)) ([11f0e02](https://github.com/Gitlawb/openclaude/commit/11f0e02b6327f333d60f8f36e872e03d2e358be1))
* enable MCP_SKILLS — discover skill:// resources as invocable skills ([#1408](https://github.com/Gitlawb/openclaude/issues/1408)) ([f111eaa](https://github.com/Gitlawb/openclaude/commit/f111eaa1b33a6dc3946f17af0d51cc5048ebc88c))
* **provider:** add OpenCode Zen/Go subscription support ([#1350](https://github.com/Gitlawb/openclaude/issues/1350)) ([5a22d60](https://github.com/Gitlawb/openclaude/commit/5a22d604f83fc68fcb2e6f41ca3586ab5044df1d))
* set process.title to 'openclaude' ([#1425](https://github.com/Gitlawb/openclaude/issues/1425)) ([f6d7a58](https://github.com/Gitlawb/openclaude/commit/f6d7a5894b20fa1aaeafd4b6e0102c3632a69895))


### Bug Fixes

* **agents:** route configured agent model overrides ([#1390](https://github.com/Gitlawb/openclaude/issues/1390)) ([a8632b4](https://github.com/Gitlawb/openclaude/commit/a8632b4cc3e77aebbcf332a235109f22eeb720bd))
* **autocompact:** retry circuit breaker after cooldown ([#1375](https://github.com/Gitlawb/openclaude/issues/1375)) ([11d59ec](https://github.com/Gitlawb/openclaude/commit/11d59ecdcb4f583a629c370a1ee9dd5e9129ce03))
* **bash:** show output for ! shell commands ([#1265](https://github.com/Gitlawb/openclaude/issues/1265)) ([#1395](https://github.com/Gitlawb/openclaude/issues/1395)) ([ac3ae10](https://github.com/Gitlawb/openclaude/commit/ac3ae109363e59df13c981646e8683192b7a6de2))
* **build:** restore /dream slash command in bundled CLI ([#1399](https://github.com/Gitlawb/openclaude/issues/1399)) ([132539f](https://github.com/Gitlawb/openclaude/commit/132539ff79f6e1eab05f94aafb3f84db644b26fc))
* **ci:** scan PR head for intent checks ([#1461](https://github.com/Gitlawb/openclaude/issues/1461)) ([276ec6a](https://github.com/Gitlawb/openclaude/commit/276ec6ab0efb5c8d93cf5c522d5b88f9787235fb))
* **docs:** update Xiaomi MiMo API URL in README. ([#1424](https://github.com/Gitlawb/openclaude/issues/1424)) ([7cc8eda](https://github.com/Gitlawb/openclaude/commit/7cc8edaa3c0d307a90ee530a253411973ed9cdc3))
* **fork:** render forked-worker messages, drop unmirrored /fork command ([#1451](https://github.com/Gitlawb/openclaude/issues/1451)) ([b900364](https://github.com/Gitlawb/openclaude/commit/b900364dbef182dbbf5522043a4fdd1c8750cb72))
* **ink:** correct stringWidth JS fallback for symbol characters ([#1244](https://github.com/Gitlawb/openclaude/issues/1244)) ([83abfa5](https://github.com/Gitlawb/openclaude/commit/83abfa506ab19676722c5dff09ce68f658af32a7))
* **launcher:** route direct Node launch paths through launcher ([#1363](https://github.com/Gitlawb/openclaude/issues/1363)) ([363583f](https://github.com/Gitlawb/openclaude/commit/363583faf55bf3cf01a712e78f03f633269451ef))
* **loader:** batch markdown reads + cap file size to unblock startup ([#1240](https://github.com/Gitlawb/openclaude/issues/1240)) ([bfb0667](https://github.com/Gitlawb/openclaude/commit/bfb0667601cde541e8ee8a472a91d786ed045a21))
* **ollama:** cap deepseek v4 pro cloud output tokens ([#1348](https://github.com/Gitlawb/openclaude/issues/1348)) ([8dd7cb0](https://github.com/Gitlawb/openclaude/commit/8dd7cb066a67db0a69deff3ce68247ec26be0142))
* **onboarding:** bound preflight probe + recover from connectivity failure ([#1017](https://github.com/Gitlawb/openclaude/issues/1017)) ([#1400](https://github.com/Gitlawb/openclaude/issues/1400)) ([c5ca847](https://github.com/Gitlawb/openclaude/commit/c5ca8476596ffb53a14d596ae55c1a95054921a7))
* **provider:** allow remote Ollama without OPENAI_API_KEY ([#952](https://github.com/Gitlawb/openclaude/issues/952)) ([01ffbb6](https://github.com/Gitlawb/openclaude/commit/01ffbb68b8db8221c2e800067d8a7c6bf17d30d2)), closes [#369](https://github.com/Gitlawb/openclaude/issues/369)
* **provider:** require API key input when adding OpenGateway ([#1384](https://github.com/Gitlawb/openclaude/issues/1384)) ([7c23fb7](https://github.com/Gitlawb/openclaude/commit/7c23fb7a050f56089e41e3492e58dc2ad3a3748f))
* **query:** keep tool failure guard across unrelated successes ([#1277](https://github.com/Gitlawb/openclaude/issues/1277)) ([cf305cc](https://github.com/Gitlawb/openclaude/commit/cf305ccc291f81fd962c3644e765b2d560678a1b))
* **release:** verify npm latest tag and document [@latest](https://github.com/latest) install ([#1378](https://github.com/Gitlawb/openclaude/issues/1378)) ([f3d41c6](https://github.com/Gitlawb/openclaude/commit/f3d41c6161db84acae464d4eaf9ad07093effe8b))
* **repl:** show permission prompts while draft input is present ([#1393](https://github.com/Gitlawb/openclaude/issues/1393)) ([70b4b07](https://github.com/Gitlawb/openclaude/commit/70b4b07908d98fd938ae338ca0bad60a80f36587)), closes [#651](https://github.com/Gitlawb/openclaude/issues/651)
* **sandbox:** guard annotateStderrWithSandboxFailures against missing runtime method (fixes Bash on builds without sandbox-runtime) ([#1452](https://github.com/Gitlawb/openclaude/issues/1452)) ([479b0e8](https://github.com/Gitlawb/openclaude/commit/479b0e8226005e4eb24bb090bfb527a483039e4c))
* **teammate-progress:** keep cumulative token+tool counts across prompts ([#475](https://github.com/Gitlawb/openclaude/issues/475)) ([#1402](https://github.com/Gitlawb/openclaude/issues/1402)) ([5247fb8](https://github.com/Gitlawb/openclaude/commit/5247fb897742d6134fd8ab97594f2c10dba336f9))
* **test:** prevent providerProfiles config mock from leaking across files ([#1432](https://github.com/Gitlawb/openclaude/issues/1432)) ([690b3f0](https://github.com/Gitlawb/openclaude/commit/690b3f07a40cec5f8f82a292e81c4c84c6926888))
* **thinking:** disable thinking for unsupported Ollama models ([#1376](https://github.com/Gitlawb/openclaude/issues/1376)) ([8513178](https://github.com/Gitlawb/openclaude/commit/85131789346f5b5e067189786e43535fbe04c20d))
* third-party provider compat — update, metrics, and refusal message ([#1406](https://github.com/Gitlawb/openclaude/issues/1406)) ([dda5ea3](https://github.com/Gitlawb/openclaude/commit/dda5ea31bd3d08db12cd2973560b008f71888663))

## [0.15.0](https://github.com/Gitlawb/openclaude/compare/v0.14.0...v0.15.0) (2026-05-26)


### Features

* **agents:** set active session agent from agents menu ([#1349](https://github.com/Gitlawb/openclaude/issues/1349)) ([7419d38](https://github.com/Gitlawb/openclaude/commit/7419d3800ca68c306df38173d6e9f5892ba85c50))
* configure API retry backoff ([#370](https://github.com/Gitlawb/openclaude/issues/370)) ([#1095](https://github.com/Gitlawb/openclaude/issues/1095)) ([d02c10b](https://github.com/Gitlawb/openclaude/commit/d02c10b399a9e30a7018646ad0c24d14f35bff13))
* **query:** robust multi-lingual and structural continuation nudge ([#1280](https://github.com/Gitlawb/openclaude/issues/1280)) ([2f8aa50](https://github.com/Gitlawb/openclaude/commit/2f8aa50cf6f87e3c64f7cf3cc07a351a22f7f950))
* **safety:** warn at startup when 3P provider + permissive mode skip the AI classifier ([#1260](https://github.com/Gitlawb/openclaude/issues/1260)) ([4e8fa24](https://github.com/Gitlawb/openclaude/commit/4e8fa24cce5de07052632d5a8a7fb4474217eab8))


### Bug Fixes

* **agent:** allow custom model overrides ([#1337](https://github.com/Gitlawb/openclaude/issues/1337)) ([785d3de](https://github.com/Gitlawb/openclaude/commit/785d3de2cd7293bdde224eaf5e9f41d275cf346b))
* **attribution:** make git attribution opt-in by default ([#1335](https://github.com/Gitlawb/openclaude/issues/1335)) ([6bc050e](https://github.com/Gitlawb/openclaude/commit/6bc050e621ac8712cd919e2e2b897ebb68b7bd67))
* **codex-stream:** recover tool args delivered only via done events ([#1262](https://github.com/Gitlawb/openclaude/issues/1262)) ([2d26a46](https://github.com/Gitlawb/openclaude/commit/2d26a4673a565301a3ee00e33e26059f37b7d44a)), closes [#1259](https://github.com/Gitlawb/openclaude/issues/1259)
* **codex:** allow credential storage fallback ([#1347](https://github.com/Gitlawb/openclaude/issues/1347)) ([f15d236](https://github.com/Gitlawb/openclaude/commit/f15d2360eeb521c19b5449df5ddd5c7cfc5639a1))
* **json-schema:** support top-level non-object roots via wrap/unwrap ([#1261](https://github.com/Gitlawb/openclaude/issues/1261)) ([07d9b4f](https://github.com/Gitlawb/openclaude/commit/07d9b4fec49dcbae67ac721ac581f4e1b3c6a4fb)), closes [#1256](https://github.com/Gitlawb/openclaude/issues/1256)
* **model:** include profile models in descriptor picker ([#1361](https://github.com/Gitlawb/openclaude/issues/1361)) ([2c87bfe](https://github.com/Gitlawb/openclaude/commit/2c87bfe055ae9bd95a297c21de9c3eee332c4337))
* route MiniMax compacting through Anthropic-compatible API ([#1154](https://github.com/Gitlawb/openclaude/issues/1154)) ([b3dc674](https://github.com/Gitlawb/openclaude/commit/b3dc674dbea8e1a740832fdde54d8fd820d501bd))
* **watchers:** debounce skills and settings reload bursts ([#1370](https://github.com/Gitlawb/openclaude/issues/1370)) ([ed91673](https://github.com/Gitlawb/openclaude/commit/ed91673f53718bca95bf31e8f0851335df020189))

## [0.14.0](https://github.com/Gitlawb/openclaude/compare/v0.13.0...v0.14.0) (2026-05-23)


### Features

* **diagnostics:** show request payload size breakdown ([#1237](https://github.com/Gitlawb/openclaude/issues/1237)) ([0aff8de](https://github.com/Gitlawb/openclaude/commit/0aff8de24f00c6cf6f1218c88b841c219c8f5a7d))
* **opengateway:** require API key on /v1/* and switch to bearer auth ([#1322](https://github.com/Gitlawb/openclaude/issues/1322)) ([0fbfc12](https://github.com/Gitlawb/openclaude/commit/0fbfc12a992883843c597ed2cf14f548dafc3975))
* **xai:** add xAI/Grok OAuth provider (browser + device-code) ([#1284](https://github.com/Gitlawb/openclaude/issues/1284)) ([326f082](https://github.com/Gitlawb/openclaude/commit/326f0826821d8e968eef4872910d3b1ffbda174a))


### Bug Fixes

* add 5-minute timeout to QueryGuard to prevent infinite spinner ([#1255](https://github.com/Gitlawb/openclaude/issues/1255)) ([23254c2](https://github.com/Gitlawb/openclaude/commit/23254c21fbb6eb6e443a575c7a662121bdb9aa13))
* allow non-OpenAI providers to skip OPENAI_API_KEY check ([#1207](https://github.com/Gitlawb/openclaude/issues/1207)) ([4897d59](https://github.com/Gitlawb/openclaude/commit/4897d597b6aadd99633a854d15e62a95a8c9907b))
* **bash:** preserve captured stdout in error message on non-zero exit ([#1236](https://github.com/Gitlawb/openclaude/issues/1236)) ([a44a83f](https://github.com/Gitlawb/openclaude/commit/a44a83f38c7156ab47c2d533abf48d18999b9239))
* **compact:** clear native tool results after time compaction ([#1278](https://github.com/Gitlawb/openclaude/issues/1278)) ([9b3c904](https://github.com/Gitlawb/openclaude/commit/9b3c90418bded3dd9cca561ecd4683fa059d19e9))
* **grpc:** register built-in agents so Agent tool isn't always empty ([#1296](https://github.com/Gitlawb/openclaude/issues/1296)) ([c366f70](https://github.com/Gitlawb/openclaude/commit/c366f7062b8f8c45c462a48a27e847413f66d9da))
* harden XAA OAuth callback state handling ([#1299](https://github.com/Gitlawb/openclaude/issues/1299)) ([bafc2a1](https://github.com/Gitlawb/openclaude/commit/bafc2a1bc53f23d2a38318d91f2a3ffdb78fb091))
* **input:** preserve split utf8 keypresses ([#1241](https://github.com/Gitlawb/openclaude/issues/1241)) ([a9f8642](https://github.com/Gitlawb/openclaude/commit/a9f8642aa8e30163f4818e08a27cdd11866eaf2f))
* MiMo remove unsupported body fields and preserve reasoning content ([#1253](https://github.com/Gitlawb/openclaude/issues/1253)) ([aab2fbc](https://github.com/Gitlawb/openclaude/commit/aab2fbcd7bcb8be3b6e288822917a577bc89b8fc))
* **monitor:** close permission dialog after selection ([#1225](https://github.com/Gitlawb/openclaude/issues/1225)) ([1aa8aab](https://github.com/Gitlawb/openclaude/commit/1aa8aab84c044347c4c2ae5b4333079165105006))
* **query:** stop repeated tool-failure loops ([#1219](https://github.com/Gitlawb/openclaude/issues/1219)) ([f71e769](https://github.com/Gitlawb/openclaude/commit/f71e7692373a61d28c82fc3fadff3feaa4071ede))
* **recovery:** keep thinking blocks on resume for reasoning-echo providers ([#1248](https://github.com/Gitlawb/openclaude/issues/1248)) ([0d3c157](https://github.com/Gitlawb/openclaude/commit/0d3c1571491b7dfeb07d5311167c2509978feb30))
* **retry:** adjust max_tokens on OpenRouter 402 credit shortfall ([#1263](https://github.com/Gitlawb/openclaude/issues/1263)) ([892c054](https://github.com/Gitlawb/openclaude/commit/892c0545ed23ee685dd5a0a0104398fa3a221181)), closes [#1125](https://github.com/Gitlawb/openclaude/issues/1125)
* **stdin,mcp:** guard rawModeEnabledCount and defer MCP connections to prevent input freeze ([#603](https://github.com/Gitlawb/openclaude/issues/603)) ([#1268](https://github.com/Gitlawb/openclaude/issues/1268)) ([90360d3](https://github.com/Gitlawb/openclaude/commit/90360d3e383314304dc19b29bd786b59e966be15))
* **TaskListV2:** revert overflowX hidden that hides task text labels ([#1215](https://github.com/Gitlawb/openclaude/issues/1215)) ([0fba154](https://github.com/Gitlawb/openclaude/commit/0fba1541a8647a805339811f6f2bac4b8d13b699))
* treat blank Read.pages as omitted ([#1269](https://github.com/Gitlawb/openclaude/issues/1269)) ([eca9dba](https://github.com/Gitlawb/openclaude/commit/eca9dba3999bb538fcd732a3cf9a50503a214312))
* **xml:** guard escapeXml/escapeXmlAttr against null and undefined ([#1250](https://github.com/Gitlawb/openclaude/issues/1250)) ([03f8791](https://github.com/Gitlawb/openclaude/commit/03f879158c6c64321b9d0703d84c0b1c47d64a52))

## [0.13.0](https://github.com/Gitlawb/openclaude/compare/v0.12.1...v0.13.0) (2026-05-17)


### Features

* **export:** add Markdown and JSON conversation exports ([#1193](https://github.com/Gitlawb/openclaude/issues/1193)) ([271bad4](https://github.com/Gitlawb/openclaude/commit/271bad4209563176ff240c89535cbb64990c23ff))


### Bug Fixes

* **bashPermissions:** apply MAX_SUBCOMMANDS cap in sandbox auto-allow path ([#1057](https://github.com/Gitlawb/openclaude/issues/1057)) ([#1166](https://github.com/Gitlawb/openclaude/issues/1166)) ([c53ef18](https://github.com/Gitlawb/openclaude/commit/c53ef1871627a4497c042199449f4f538a9c6ffa))
* **gemini:** parse raw tool call text ([#1212](https://github.com/Gitlawb/openclaude/issues/1212)) ([2d20109](https://github.com/Gitlawb/openclaude/commit/2d20109edc8b238d7c6118ab9c5a4126ad0726bc))
* **spinner:** prevent layout shift during thinking and orphaned task icons ([#1211](https://github.com/Gitlawb/openclaude/issues/1211)) ([8470832](https://github.com/Gitlawb/openclaude/commit/8470832e5c705d98dc0ec50066be3537c8a1b589))
* **websearch:** surface adapter failure when auto mode falls back to native ([#994](https://github.com/Gitlawb/openclaude/issues/994)) ([#1168](https://github.com/Gitlawb/openclaude/issues/1168)) ([b3b7714](https://github.com/Gitlawb/openclaude/commit/b3b771476d8c3678c0225b32515e02c1dd730571))

## [0.12.1](https://github.com/Gitlawb/openclaude/compare/v0.12.0...v0.12.1) (2026-05-16)


### Bug Fixes

* **entrypoint:** apply --max-old-space-size=8192 universally, not just CCR ([#1191](https://github.com/Gitlawb/openclaude/issues/1191)) ([4d0603e](https://github.com/Gitlawb/openclaude/commit/4d0603e9906b24d0f4f3fc683db1950879875e16))
* **gemini:** preserve tool calls through opengateway ([#1204](https://github.com/Gitlawb/openclaude/issues/1204)) ([13a0901](https://github.com/Gitlawb/openclaude/commit/13a090162f9b0c53080aaaa1cfa937cd9981596e))

## [0.12.0](https://github.com/Gitlawb/openclaude/compare/v0.11.0...v0.12.0) (2026-05-16)


### Features

* **opengateway:** add Gemini 3.1 Flash Lite + GLM 5.1 FP8 to catalog ([#1194](https://github.com/Gitlawb/openclaude/issues/1194)) ([4d04f5b](https://github.com/Gitlawb/openclaude/commit/4d04f5bf4f1acc9d3cc00dab0b1b697e13711207))


### Bug Fixes

* **openai-shim:** surface in-stream errors and truncation hints ([#1174](https://github.com/Gitlawb/openclaude/issues/1174)) ([6174d75](https://github.com/Gitlawb/openclaude/commit/6174d75e983e80601ba369a595d7b64580e3bd51))
* Reduce stable stringify heap usage ([#1104](https://github.com/Gitlawb/openclaude/issues/1104)) ([c433d20](https://github.com/Gitlawb/openclaude/commit/c433d20fdc5666736c800a942bbcc0f0d85cc296))

## [0.11.0](https://github.com/Gitlawb/openclaude/compare/v0.10.0...v0.11.0) (2026-05-14)


### Features

* add sponsored tips with frequency-gated display ([#1140](https://github.com/Gitlawb/openclaude/issues/1140)) ([a4cbb78](https://github.com/Gitlawb/openclaude/commit/a4cbb785854619689dbedcec54b6b7739529fdd0))
* **groq:** dynamic model discovery with mapModel filtering and hybrid catalog ([#1143](https://github.com/Gitlawb/openclaude/issues/1143)) ([a65bdb4](https://github.com/Gitlawb/openclaude/commit/a65bdb41b84e7454ef2f50921ea56f04464f0455))
* implement high-performance SQLite storage layer with JSON audit log (Phase 2 Masterpiece) ([#1106](https://github.com/Gitlawb/openclaude/issues/1106)) ([e12432e](https://github.com/Gitlawb/openclaude/commit/e12432eaf68be2ded987f83b16f1d4ae994d4d2b))
* **nvidia-nim:** add latest chat models, remove duplicate Mixtral 8x22B entry. Verified against integrate.api.nvidia.com/v1/models on 2026-05-13. Tracks [#1099](https://github.com/Gitlawb/openclaude/issues/1099). ([#1145](https://github.com/Gitlawb/openclaude/issues/1145)) ([0f6668f](https://github.com/Gitlawb/openclaude/commit/0f6668f554a9ed687095a3ce244fdf246cfe884c))
* **provider:** add Gitlawb Opengateway as default provider with MiMo ([#1165](https://github.com/Gitlawb/openclaude/issues/1165)) ([5b5ba88](https://github.com/Gitlawb/openclaude/commit/5b5ba8853bd8b3d922b957a96484e1092cd3a6a3))
* **provider:** add Venice official provider ([#1109](https://github.com/Gitlawb/openclaude/issues/1109)) ([f9621ab](https://github.com/Gitlawb/openclaude/commit/f9621ab575762453bff5d224e1e6f44067d9b1f3))
* **provider:** add Xiaomi MiMo integration ([#1152](https://github.com/Gitlawb/openclaude/issues/1152)) ([18483e4](https://github.com/Gitlawb/openclaude/commit/18483e4d96e9763993af116112a0fee4877a1227))


### Bug Fixes

* **agent:** prevent mid-flight peeking and taking over of forks ([#1153](https://github.com/Gitlawb/openclaude/issues/1153)) ([74e3947](https://github.com/Gitlawb/openclaude/commit/74e3947d881802420b860f1e6b9f156fecdd65d7))
* **bashPermissions:** block command substitution in array subscript position ([#1111](https://github.com/Gitlawb/openclaude/issues/1111)) ([4a98a4a](https://github.com/Gitlawb/openclaude/commit/4a98a4a227d148a3ff0ac05f20f32a0f7888a5be))
* **bashSecurity:** tighten fc -e detection to avoid long-flag false positives ([#1107](https://github.com/Gitlawb/openclaude/issues/1107)) ([0c88def](https://github.com/Gitlawb/openclaude/commit/0c88defbe0014f434b6ae5d419c8a6234463294e))
* **codex:** normalize empty MCP object schemas ([#1121](https://github.com/Gitlawb/openclaude/issues/1121)) ([7ea74f2](https://github.com/Gitlawb/openclaude/commit/7ea74f29f0cf01654da37deef52d9350a34b6c89))
* **errors:** surface re-auth hint on OAuth token expiry 401s ([#1042](https://github.com/Gitlawb/openclaude/issues/1042)) ([#1142](https://github.com/Gitlawb/openclaude/issues/1142)) ([921594e](https://github.com/Gitlawb/openclaude/commit/921594efc46792d2af969ab948a2ccde3c64e062))
* hide missing-module slash command stubs ([#1136](https://github.com/Gitlawb/openclaude/issues/1136)) ([cf33f03](https://github.com/Gitlawb/openclaude/commit/cf33f0375543afc26492426f55f8d81647288e79))
* **integrations:** cap gpt-5.5 context window at Codex effective limit ([#1118](https://github.com/Gitlawb/openclaude/issues/1118)) ([#1141](https://github.com/Gitlawb/openclaude/issues/1141)) ([cac11dc](https://github.com/Gitlawb/openclaude/commit/cac11dce0d5b3850c0f338fda0bbb15ba25f6aa3))
* replace raw abort signal timeouts ([#1123](https://github.com/Gitlawb/openclaude/issues/1123)) ([877b4dc](https://github.com/Gitlawb/openclaude/commit/877b4dc88600062d8bbfaf764bfbd828c55699e8))
* surface actionable error when fetch fails in _doOpenAIRequest ([#447](https://github.com/Gitlawb/openclaude/issues/447)) ([3af0924](https://github.com/Gitlawb/openclaude/commit/3af092441d36d77cc5b23c69225be568ef8d355c))
* update vulnerable dependencies ([#1149](https://github.com/Gitlawb/openclaude/issues/1149)) ([5328f57](https://github.com/Gitlawb/openclaude/commit/5328f57a724b15fcf688cdfd0c1d52c3de926059))

## [0.10.0](https://github.com/Gitlawb/openclaude/compare/v0.9.2...v0.10.0) (2026-05-11)


### Features

* Add startup logo palette picker ([#1072](https://github.com/Gitlawb/openclaude/issues/1072)) ([ed7b697](https://github.com/Gitlawb/openclaude/commit/ed7b6972f9cd7d36cd604738f5160064061ab254))
* **cli:** honor --model alone without requiring --provider ([#854](https://github.com/Gitlawb/openclaude/issues/854)) ([7cfc8d5](https://github.com/Gitlawb/openclaude/commit/7cfc8d5dad1aa3be247c3197e3442d9f70691db1))
* incremental and cached token counting ([#795](https://github.com/Gitlawb/openclaude/issues/795)) ([4b1e516](https://github.com/Gitlawb/openclaude/commit/4b1e516fc70c07da6ad678df35030fa114cc8918))
* **knowledge:** introduce local Orama persistence (feature-flagged) ([#1015](https://github.com/Gitlawb/openclaude/issues/1015)) ([5873bc6](https://github.com/Gitlawb/openclaude/commit/5873bc67141b6345d0630112a84d7fcfb149b584))
* make Orama the default search engine with JSON-backed ([#1094](https://github.com/Gitlawb/openclaude/issues/1094)) ([f443669](https://github.com/Gitlawb/openclaude/commit/f4436697f02cc626bb55c3c4db1cd86938471e37))
* **websearch:** add first-class Brave adapter; fix Google + Brave presets; restore Exa snippets ([#1044](https://github.com/Gitlawb/openclaude/issues/1044)) ([402cd3d](https://github.com/Gitlawb/openclaude/commit/402cd3dbe81835cc6a658b31355d16697f9e6346))


### Bug Fixes

* **agent:** ensure main agent waits for subagent completion ([#1032](https://github.com/Gitlawb/openclaude/issues/1032)) ([6af709e](https://github.com/Gitlawb/openclaude/commit/6af709e65ea61e9071cbccbdcd7c57fe87b0710e))
* **agents:** coerce non-string whenToUse to prevent crash on save ([#1086](https://github.com/Gitlawb/openclaude/issues/1086)) ([#1087](https://github.com/Gitlawb/openclaude/issues/1087)) ([fc89767](https://github.com/Gitlawb/openclaude/commit/fc8976708b9648bb021bc80270eb9e1d416bef37))
* **bashSecurity:** reject nested heredoc ranges in stripSafeHeredocSubstitutions ([#1050](https://github.com/Gitlawb/openclaude/issues/1050)) ([ebc9c70](https://github.com/Gitlawb/openclaude/commit/ebc9c70bb5eb7224ff94604b662d5285377ee18a))
* **effort:** persist xhigh and send reasoning_effort on chat_completions ([#857](https://github.com/Gitlawb/openclaude/issues/857)) ([feb5791](https://github.com/Gitlawb/openclaude/commit/feb579132016ef73dfaa5f20c073fcd3c91ecd80))
* **openai-shim:** redact ?auth=, ?passwd=, ?pwd= in diagnostic URLs ([#1070](https://github.com/Gitlawb/openclaude/issues/1070)) ([20bc6ae](https://github.com/Gitlawb/openclaude/commit/20bc6aec21a11bde4d2357c2ce45d97233be09b9)), closes [#1069](https://github.com/Gitlawb/openclaude/issues/1069)
* **openai-shim:** strip `store` for local providers (vLLM, custom) ([#1048](https://github.com/Gitlawb/openclaude/issues/1048)) ([4830d6f](https://github.com/Gitlawb/openclaude/commit/4830d6f778c57ae83c12aeda65108e1f5e23acaf))
* **openai-shim:** strip `store` when baseUrl points at Cerebras ([#1040](https://github.com/Gitlawb/openclaude/issues/1040)) ([0adf97d](https://github.com/Gitlawb/openclaude/commit/0adf97dc14f149eb4bcdd0cefcf45dd87eae4f2a))
* replace unsupported Unicode glyphs with widely available alternatives ([#1088](https://github.com/Gitlawb/openclaude/issues/1088)) ([e1e277a](https://github.com/Gitlawb/openclaude/commit/e1e277a3af7217822d41e5b9dc919033d0839db8))
* resolve two bugs making interactive mode unusable with plugin ecosystems ([#825](https://github.com/Gitlawb/openclaude/issues/825)) ([#830](https://github.com/Gitlawb/openclaude/issues/830)) ([e438c89](https://github.com/Gitlawb/openclaude/commit/e438c89fbceefcfb86a8ecdaae6d5a119a92a33b))
* validate plugin component paths ([#1096](https://github.com/Gitlawb/openclaude/issues/1096)) ([9fed6ae](https://github.com/Gitlawb/openclaude/commit/9fed6ae4a0158695719d5ee58b453dc8c6019c0c))


### Performance Improvements

* **local:** add OPENCLAUDE_LOCAL_FAST_PATH to skip cloud-only transforms ([#1068](https://github.com/Gitlawb/openclaude/issues/1068)) ([4fad5d2](https://github.com/Gitlawb/openclaude/commit/4fad5d25dadbaee3712a2dd3749d1a9e8363a0b7)), closes [#1016](https://github.com/Gitlawb/openclaude/issues/1016)

## [0.9.2](https://github.com/Gitlawb/openclaude/compare/v0.9.1...v0.9.2) (2026-05-06)


### Bug Fixes

* **cli:** replace createRequire with static import for teammate.js ([#1026](https://github.com/Gitlawb/openclaude/issues/1026)) ([#1033](https://github.com/Gitlawb/openclaude/issues/1033)) ([c873725](https://github.com/Gitlawb/openclaude/commit/c873725d901c9fd612140603da964894ef69e510))

## [0.9.1](https://github.com/Gitlawb/openclaude/compare/v0.9.0...v0.9.1) (2026-05-05)


### Bug Fixes

* **theme:** remove stale memo wrappers from theme context hooks ([#534](https://github.com/Gitlawb/openclaude/issues/534)) ([094f04c](https://github.com/Gitlawb/openclaude/commit/094f04c8036200eb3c51b7b7b4ec3c75ee83b3a0))

## [0.9.0](https://github.com/Gitlawb/openclaude/compare/v0.8.0...v0.9.0) (2026-05-05)


### Features

* context partitioning and relevance-based pruning ([#849](https://github.com/Gitlawb/openclaude/issues/849)) ([ca676af](https://github.com/Gitlawb/openclaude/commit/ca676affc47dca7f2a65fa867410931e27ae4969))
* rework release notes around GitHub releases ([#981](https://github.com/Gitlawb/openclaude/issues/981)) ([d948769](https://github.com/Gitlawb/openclaude/commit/d948769dd59c5533fa9769c0f16de783010b4620))
* SDK Runtime — Query Engine, Sessions, and Build Pipeline ([#984](https://github.com/Gitlawb/openclaude/issues/984)) ([60c76b6](https://github.com/Gitlawb/openclaude/commit/60c76b6599f691781ad5ae7dfeb6e4029b679d0a))
* support self-hosted Firecrawl via FIRECRAWL_API_URL ([#949](https://github.com/Gitlawb/openclaude/issues/949)) ([a133e76](https://github.com/Gitlawb/openclaude/commit/a133e7631a7c0b6eeb624d60567147cab1257ff0))


### Bug Fixes

* **groq:** strip unsupported store field ([#983](https://github.com/Gitlawb/openclaude/issues/983)) ([6d0953a](https://github.com/Gitlawb/openclaude/commit/6d0953a79cb435b17ed231019fa0b660b770c914))
* **mcp:** allow third-party providers to approve project-scope .mcp.json servers ([#696](https://github.com/Gitlawb/openclaude/issues/696)) ([#937](https://github.com/Gitlawb/openclaude/issues/937)) ([dc3c065](https://github.com/Gitlawb/openclaude/commit/dc3c065c4a70663978f965d50846ba6a0692e59d))
* **shims:** strip x-anthropic-billing-header block before forwarding system prompt ([#1019](https://github.com/Gitlawb/openclaude/issues/1019)) ([40ae1e7](https://github.com/Gitlawb/openclaude/commit/40ae1e720034f00912762d5e723903d3170bc396))
* **startup:** make CLAUDE logo D distinct ([#986](https://github.com/Gitlawb/openclaude/issues/986)) ([35f86a9](https://github.com/Gitlawb/openclaude/commit/35f86a9580aedd3f359dfc13992e49f2ec53757e))
* **tests:** resolve flakiness due to module leak and env state leakage ([#988](https://github.com/Gitlawb/openclaude/issues/988)) ([990a5a2](https://github.com/Gitlawb/openclaude/commit/990a5a2afbb22b8f9274328783a6adbda1a3b62c))
* **web-search:** surface diagnostic when adapter returns 0 hits and no native fallback ([#1006](https://github.com/Gitlawb/openclaude/issues/1006)) ([1c74675](https://github.com/Gitlawb/openclaude/commit/1c746750f67d576b8272ba985b65c9c4406bdbc9))

## [0.8.0](https://github.com/Gitlawb/openclaude/compare/v0.7.0...v0.8.0) (2026-05-02)


### Features

* add Opus 4.7 as default model and fix alias/thinking bugs ([#928](https://github.com/Gitlawb/openclaude/issues/928)) ([4c93a9f](https://github.com/Gitlawb/openclaude/commit/4c93a9f9f168217d4bdd53d103337e43f28be074))
* add streaming token counter ([#797](https://github.com/Gitlawb/openclaude/issues/797)) ([0ca4333](https://github.com/Gitlawb/openclaude/commit/0ca43335375beec6e58711b797d5b0c4bb5019b8))
* **api:** deterministic request-body serialization via stableStringify ([#882](https://github.com/Gitlawb/openclaude/issues/882)) ([6ea3eb6](https://github.com/Gitlawb/openclaude/commit/6ea3eb64830ccfec1436bcebe2406158e14a7e81))
* **cli:** improve SSH interactivity detection via SSH_TTY and SSH_CONNECTION ([#946](https://github.com/Gitlawb/openclaude/issues/946)) ([aae96aa](https://github.com/Gitlawb/openclaude/commit/aae96aa52a1241661116d62aac884ddeafd7835b))
* context preloading and hybrid context strategy ([#860](https://github.com/Gitlawb/openclaude/issues/860)) ([92d297e](https://github.com/Gitlawb/openclaude/commit/92d297e50efcc7225f57f0d3cb0ba989dc40d624))
* **lsp:** add first-class code intelligence setup ([#950](https://github.com/Gitlawb/openclaude/issues/950)) ([677d29f](https://github.com/Gitlawb/openclaude/commit/677d29ffd42410710150f1eb8942190c8d317fe0))
* SDK Core — Permission System, Async Context, and Engine Extensions ([#951](https://github.com/Gitlawb/openclaude/issues/951)) ([a46b31c](https://github.com/Gitlawb/openclaude/commit/a46b31c3ec1840a712b9ad2cdd4f9d0f359544c9))
* SDK Foundation — Type Declarations, Errors, and Utilities ([#866](https://github.com/Gitlawb/openclaude/issues/866)) ([91f93ce](https://github.com/Gitlawb/openclaude/commit/91f93ce61533a9cadd1d107e09a442451c09f5db))


### Bug Fixes

* avoid legacy Windows PasswordVault reads by default ([#941](https://github.com/Gitlawb/openclaude/issues/941)) ([d321c8f](https://github.com/Gitlawb/openclaude/commit/d321c8fc6a0be6731c1ccfec0fca8023b1a8b67e))
* **errors:** show actual host in 404 message instead of Ollama hint ([#926](https://github.com/Gitlawb/openclaude/issues/926)) ([#931](https://github.com/Gitlawb/openclaude/issues/931)) ([4fab8b9](https://github.com/Gitlawb/openclaude/commit/4fab8b913f8b5301b98eb8dcf42dd75f095a3c60))
* **input:** strip leading ! when entering bash mode ([#947](https://github.com/Gitlawb/openclaude/issues/947)) ([5943c5c](https://github.com/Gitlawb/openclaude/commit/5943c5c269cdeba45879dac0d8da0082e28cc2a2)), closes [#662](https://github.com/Gitlawb/openclaude/issues/662)
* **oauth:** skip refresh for third-party providers ([#955](https://github.com/Gitlawb/openclaude/issues/955)) ([208c896](https://github.com/Gitlawb/openclaude/commit/208c896c07b878e2859fbae7e0f31697d59943ce))
* **openai-shim:** don't label transport failures as HTTP 503 ([#971](https://github.com/Gitlawb/openclaude/issues/971)) ([#975](https://github.com/Gitlawb/openclaude/issues/975)) ([cc0dab6](https://github.com/Gitlawb/openclaude/commit/cc0dab60a3721921f949165b93c8c997b1aae4a2))
* **openai-shim:** strip `store` when baseUrl points at Gemini ([#959](https://github.com/Gitlawb/openclaude/issues/959)) ([0f0fd26](https://github.com/Gitlawb/openclaude/commit/0f0fd266dbe9363b0ea1db29d8c10ed0b9b18413)), closes [#664](https://github.com/Gitlawb/openclaude/issues/664)
* **plugins:** sanitize env before spawning git so /plugin marketplace add works ([#751](https://github.com/Gitlawb/openclaude/issues/751)) ([#934](https://github.com/Gitlawb/openclaude/issues/934)) ([5c4fdca](https://github.com/Gitlawb/openclaude/commit/5c4fdca21743f82071d0ee22534d61c9ad677efe))
* **provider:** apply Codex OAuth session switch correctly ([#974](https://github.com/Gitlawb/openclaude/issues/974)) ([95a817f](https://github.com/Gitlawb/openclaude/commit/95a817fdb08a97b6293c6c7f87457bcd98283714))
* **ripgrep:** use @vscode/ripgrep package as the builtin source ([#911](https://github.com/Gitlawb/openclaude/issues/911)) ([#932](https://github.com/Gitlawb/openclaude/issues/932)) ([ee0d930](https://github.com/Gitlawb/openclaude/commit/ee0d9300939db0c6178bfad4707a0be45f126d1f))
* **typecheck:** make `bun run typecheck` actionable on main ([#473](https://github.com/Gitlawb/openclaude/issues/473)) ([#938](https://github.com/Gitlawb/openclaude/issues/938)) ([8106880](https://github.com/Gitlawb/openclaude/commit/8106880855ee0bb4b5bbca8827cfe97fe99558b8))
* **worktree:** surface git stderr in rev-parse failure message ([#690](https://github.com/Gitlawb/openclaude/issues/690)) ([#954](https://github.com/Gitlawb/openclaude/issues/954)) ([7711dda](https://github.com/Gitlawb/openclaude/commit/7711ddae4807332526ea128c0246b479d5c0ed00))

## [0.7.0](https://github.com/Gitlawb/openclaude/compare/v0.6.0...v0.7.0) (2026-04-26)


### Features

* add model-specific tokenizers and compression ratio detection ([#799](https://github.com/Gitlawb/openclaude/issues/799)) ([e92e527](https://github.com/Gitlawb/openclaude/commit/e92e5274b223d935d380b1fbd234cb631ab03211))
* add OPENCLAUDE_DISABLE_TOOL_REMINDERS env var to suppress hidden tool-output reminders ([#837](https://github.com/Gitlawb/openclaude/issues/837)) ([28de94d](https://github.com/Gitlawb/openclaude/commit/28de94df5dcd7718cb334e2e793e9472f5b291c5)), closes [#809](https://github.com/Gitlawb/openclaude/issues/809)
* add streaming optimizer and structured request logging ([#703](https://github.com/Gitlawb/openclaude/issues/703)) ([5b9cd21](https://github.com/Gitlawb/openclaude/commit/5b9cd21e373823a77fd552d6e02f5d4b68ae06b1))
* add xAI as official provider ([#865](https://github.com/Gitlawb/openclaude/issues/865)) ([2586a9c](https://github.com/Gitlawb/openclaude/commit/2586a9cddbd2512826bca81cb5deb3ec97f00f0f))
* **api:** expose cache metrics in REPL + normalize across providers ([#813](https://github.com/Gitlawb/openclaude/issues/813)) ([9e23c2b](https://github.com/Gitlawb/openclaude/commit/9e23c2bec43697187762601db5b1585c9b0fb1a3))
* implement Hook Chains runtime integration for self-healing agent mesh MVP ([#711](https://github.com/Gitlawb/openclaude/issues/711)) ([44a2c30](https://github.com/Gitlawb/openclaude/commit/44a2c30d5f9b98027e454466c680360f6b4625fc))
* **memory:** implement persistent project-level Knowledge Graph and RAG ([#899](https://github.com/Gitlawb/openclaude/issues/899)) ([29f7579](https://github.com/Gitlawb/openclaude/commit/29f757937732be0f8cca2bc0627a27eeafc2a992))
* **minimax:** add /usage support and fix MiniMax quota parsing ([#869](https://github.com/Gitlawb/openclaude/issues/869)) ([26413f6](https://github.com/Gitlawb/openclaude/commit/26413f6d307928a4f14c9c61c9860a28f8d81358))
* **model:** add GPT-5.5 support for Codex provider ([#880](https://github.com/Gitlawb/openclaude/issues/880)) ([038f715](https://github.com/Gitlawb/openclaude/commit/038f715b7ab9714340bda421b73a86d8590cf531))
* **tools:** resilient web search and fetch across all providers ([#836](https://github.com/Gitlawb/openclaude/issues/836)) ([531e3f1](https://github.com/Gitlawb/openclaude/commit/531e3f10592a73d81f26675c2479d46a3d5b55f5))
* **zai:** add Z.AI GLM Coding Plan provider preset ([#896](https://github.com/Gitlawb/openclaude/issues/896)) ([a0d657e](https://github.com/Gitlawb/openclaude/commit/a0d657ee188f52f8a4ceaad1658c81343a32fdad))


### Bug Fixes

* **agent:** provider-aware fallback for haiku/sonnet aliases ([#908](https://github.com/Gitlawb/openclaude/issues/908)) ([a3e728a](https://github.com/Gitlawb/openclaude/commit/a3e728a114f6379b80daefc8abcac17a752c5f96))
* bugs ([#885](https://github.com/Gitlawb/openclaude/issues/885)) ([c6c5f06](https://github.com/Gitlawb/openclaude/commit/c6c5f0608cf6509b412b121954547d72b3f3a411))
* make OpenAI fallback context window configurable + support external model lookup ([#861](https://github.com/Gitlawb/openclaude/issues/861)) ([b750e9e](https://github.com/Gitlawb/openclaude/commit/b750e9e97d15926d094d435772b2d6d12e5e545c))
* **mcp:** disable MCP_SKILLS feature flag — source not mirrored ([#872](https://github.com/Gitlawb/openclaude/issues/872)) ([dcbe295](https://github.com/Gitlawb/openclaude/commit/dcbe29558ab9c74d335b138488005a6509aa906a))
* normalize /provider multi-model selection and semicolon parsing ([#841](https://github.com/Gitlawb/openclaude/issues/841)) ([c4cb98a](https://github.com/Gitlawb/openclaude/commit/c4cb98a4f092062da02a4728cf59fed0fc3a6d3f))
* **openai-shim:** echo reasoning_content on assistant tool-call messages for Moonshot ([#828](https://github.com/Gitlawb/openclaude/issues/828)) ([67de6bd](https://github.com/Gitlawb/openclaude/commit/67de6bd2cffc3381f0f28fd3ffce043970611667))
* **query:** restore system prompt structure and add missing config import ([#907](https://github.com/Gitlawb/openclaude/issues/907)) ([818689b](https://github.com/Gitlawb/openclaude/commit/818689b2ee71cb6966cb4dc5a5ebd90fd22b0fcb))
* **shell:** recover when CWD path was replaced by a non-directory ([#871](https://github.com/Gitlawb/openclaude/issues/871)) ([a4c6757](https://github.com/Gitlawb/openclaude/commit/a4c67570238794317d049a225396672b465fdbfc))
* **startup:** show --model flag override on startup screen ([#898](https://github.com/Gitlawb/openclaude/issues/898)) ([d45628c](https://github.com/Gitlawb/openclaude/commit/d45628c41300b83b466e6a97983099615a50e7d7))
* **startup:** url authoritative over model name in banner provider detect ([#864](https://github.com/Gitlawb/openclaude/issues/864)) ([e346b8d](https://github.com/Gitlawb/openclaude/commit/e346b8d5ec2d58a4e8db337918d52d844ee52766)), closes [#855](https://github.com/Gitlawb/openclaude/issues/855)
* surface actionable error when DuckDuckGo web search is rate-limited ([#834](https://github.com/Gitlawb/openclaude/issues/834)) ([3c4d843](https://github.com/Gitlawb/openclaude/commit/3c4d8435c42e1ee04f9defd31c4c589017f524c5))
* **test:** add missing teammate exports to hookChains integration mock ([#840](https://github.com/Gitlawb/openclaude/issues/840)) ([23e8cfb](https://github.com/Gitlawb/openclaude/commit/23e8cfbd5b22179684276bef4131e26b830ce69c)), closes [#839](https://github.com/Gitlawb/openclaude/issues/839)
* **update:** show real package version and give actionable guidance ([#870](https://github.com/Gitlawb/openclaude/issues/870)) ([6e58b81](https://github.com/Gitlawb/openclaude/commit/6e58b819370128b923dda4fcc774bb556f4b951a))

## [0.6.0](https://github.com/Gitlawb/openclaude/compare/v0.5.2...v0.6.0) (2026-04-22)


### Features

* add model caching and benchmarking utilities ([#671](https://github.com/Gitlawb/openclaude/issues/671)) ([2b15e16](https://github.com/Gitlawb/openclaude/commit/2b15e16421f793f954a92c53933a07094544b29d))
* add thinking token extraction ([#798](https://github.com/Gitlawb/openclaude/issues/798)) ([268c039](https://github.com/Gitlawb/openclaude/commit/268c0398e4bf1ab898069c61500a2b3c226a0322))
* **api:** compress old tool_result content for small-context providers ([#801](https://github.com/Gitlawb/openclaude/issues/801)) ([a6a3de5](https://github.com/Gitlawb/openclaude/commit/a6a3de5ac155fe9d00befbfcab98d439314effd8))
* **api:** improve local provider reliability with readiness and self-healing ([#738](https://github.com/Gitlawb/openclaude/issues/738)) ([4cb963e](https://github.com/Gitlawb/openclaude/commit/4cb963e660dbd6ee438c04042700db05a9d32c59))
* **api:** smart model routing primitive (cheap-for-simple, strong-for-hard) ([#785](https://github.com/Gitlawb/openclaude/issues/785)) ([e908864](https://github.com/Gitlawb/openclaude/commit/e908864da7e7c987a98053ac5d18d702e192db2b))
* enable 15 additional feature flags in open build ([#667](https://github.com/Gitlawb/openclaude/issues/667)) ([6a62e3f](https://github.com/Gitlawb/openclaude/commit/6a62e3ff76ba9ba446b8e20cf2bb139ee76a9387))
* native Anthropic API mode for Claude models on GitHub Copilot ([#579](https://github.com/Gitlawb/openclaude/issues/579)) ([fdef4a1](https://github.com/Gitlawb/openclaude/commit/fdef4a1b4ce218ded4937ca83b30acce7c726472))
* **provider:** expose Atomic Chat in /provider picker with autodetect ([#810](https://github.com/Gitlawb/openclaude/issues/810)) ([ee19159](https://github.com/Gitlawb/openclaude/commit/ee19159c17b3de3b4a8b4a4541a6569f4261d54e))
* **provider:** zero-config autodetection primitive ([#784](https://github.com/Gitlawb/openclaude/issues/784)) ([a5bfcbb](https://github.com/Gitlawb/openclaude/commit/a5bfcbbadf8e9a1fd42f3e103d295524b8da64b0))


### Bug Fixes

* **api:** ensure strict role sequence and filter empty assistant messages after interruption ([#745](https://github.com/Gitlawb/openclaude/issues/745) regression) ([#794](https://github.com/Gitlawb/openclaude/issues/794)) ([06e7684](https://github.com/Gitlawb/openclaude/commit/06e7684eb56df8e694ac784575e163641931c44c))
* Collapse all-text arrays to string for DeepSeek compatibility ([#806](https://github.com/Gitlawb/openclaude/issues/806)) ([761924d](https://github.com/Gitlawb/openclaude/commit/761924daa7e225fe8acf41651408c7cae639a511))
* **model:** codex/nvidia-nim/minimax now read OPENAI_MODEL env ([#815](https://github.com/Gitlawb/openclaude/issues/815)) ([4581208](https://github.com/Gitlawb/openclaude/commit/458120889f6ce54cc9f0b287461d5e38eae48a20))
* **provider:** saved profile ignored when stale CLAUDE_CODE_USE_* in shell ([#807](https://github.com/Gitlawb/openclaude/issues/807)) ([13de4e8](https://github.com/Gitlawb/openclaude/commit/13de4e85df7f5fadc8cd15a76076374dc112360b))
* rename .claude.json to .openclaude.json with legacy fallback ([#582](https://github.com/Gitlawb/openclaude/issues/582)) ([4d4fb28](https://github.com/Gitlawb/openclaude/commit/4d4fb2880e4d0e3a62d8715e1ec13d932e736279))
* replace discontinued gemini-2.5-pro-preview-03-25 with stable gemini-2.5-pro ([#802](https://github.com/Gitlawb/openclaude/issues/802)) ([64582c1](https://github.com/Gitlawb/openclaude/commit/64582c119d5d0278195271379da4a68d59a89c1f)), closes [#398](https://github.com/Gitlawb/openclaude/issues/398)
* **security:** harden project settings trust boundary + MCP sanitization ([#789](https://github.com/Gitlawb/openclaude/issues/789)) ([ae3b723](https://github.com/Gitlawb/openclaude/commit/ae3b723f3b297b49925cada4728f3174aee8bf12))
* **test:** autoCompact floor assertion is flag-sensitive ([#816](https://github.com/Gitlawb/openclaude/issues/816)) ([c13842e](https://github.com/Gitlawb/openclaude/commit/c13842e91c7227246520955de6ae0636b30def9a))
* **ui:** prevent provider manager lag by deferring sync I/O ([#803](https://github.com/Gitlawb/openclaude/issues/803)) ([85eab27](https://github.com/Gitlawb/openclaude/commit/85eab2751e7d351bb0ed6a3fe0e15461d241c9cb))

## [0.5.2](https://github.com/Gitlawb/openclaude/compare/v0.5.1...v0.5.2) (2026-04-20)


### Bug Fixes

* **api:** replace phrase-based reasoning sanitizer with tag-based filter ([#779](https://github.com/Gitlawb/openclaude/issues/779)) ([336ddcc](https://github.com/Gitlawb/openclaude/commit/336ddcc50d59d79ebff50993f2673652aecb0d7d))

## [0.5.1](https://github.com/Gitlawb/openclaude/compare/v0.5.0...v0.5.1) (2026-04-20)


### Bug Fixes

* enforce Bash path constraints after sandbox allow ([#777](https://github.com/Gitlawb/openclaude/issues/777)) ([7002cb3](https://github.com/Gitlawb/openclaude/commit/7002cb302b78ea2a19da3f26226de24e2903fa1d))
* enforce MCP OAuth callback state before errors ([#775](https://github.com/Gitlawb/openclaude/issues/775)) ([739b8d1](https://github.com/Gitlawb/openclaude/commit/739b8d1f40fde0e401a5cbd2b9a55d88bd5124ad))
* require trusted approval for sandbox override ([#778](https://github.com/Gitlawb/openclaude/issues/778)) ([aab4890](https://github.com/Gitlawb/openclaude/commit/aab489055c53dd64369414116fe93226d2656273))

## [0.5.0](https://github.com/Gitlawb/openclaude/compare/v0.4.0...v0.5.0) (2026-04-20)


### Features

* add OPENCLAUDE_DISABLE_STRICT_TOOLS env var to opt out of strict MCP tool schema normalization ([#770](https://github.com/Gitlawb/openclaude/issues/770)) ([e6e8d9a](https://github.com/Gitlawb/openclaude/commit/e6e8d9a24897e4c9ef08b72df20fabbf8ef27f38))
* mask provider api key input ([#772](https://github.com/Gitlawb/openclaude/issues/772)) ([13e9f22](https://github.com/Gitlawb/openclaude/commit/13e9f22a83a2b0f85f557b1e12c9442ba61241e4))


### Bug Fixes

* allow provider recovery during startup ([#765](https://github.com/Gitlawb/openclaude/issues/765)) ([f828171](https://github.com/Gitlawb/openclaude/commit/f828171ef1ab94e2acf73a28a292799e4e26cc0d))
* **api:** drop orphan tool results to satisfy strict role sequence ([#745](https://github.com/Gitlawb/openclaude/issues/745)) ([b786b76](https://github.com/Gitlawb/openclaude/commit/b786b765f01f392652eaf28ed3579a96b7260a53))
* **help:** prevent /help tab crash from undefined descriptions ([#732](https://github.com/Gitlawb/openclaude/issues/732)) ([3d1979f](https://github.com/Gitlawb/openclaude/commit/3d1979ff066db32415e0c8321af916d81f5f2621))
* **mcp:** sync required array with properties in tool schemas ([#754](https://github.com/Gitlawb/openclaude/issues/754)) ([002a8f1](https://github.com/Gitlawb/openclaude/commit/002a8f1f6de2fcfc917165d828501d3047bad61f))
* remove cached mcpClient in diagnostic tracking to prevent stale references ([#727](https://github.com/Gitlawb/openclaude/issues/727)) ([2c98be7](https://github.com/Gitlawb/openclaude/commit/2c98be700274a4241963b5f43530bf3bd8f8963f))
* use raw context window for auto-compact percentage display ([#748](https://github.com/Gitlawb/openclaude/issues/748)) ([55c5f26](https://github.com/Gitlawb/openclaude/commit/55c5f262a9a5a8be0aa9ae8dc6c7dafc465eb2c6))

## [0.4.0](https://github.com/Gitlawb/openclaude/compare/v0.3.0...v0.4.0) (2026-04-17)


### Features

* add Alibaba Coding Plan (DashScope) provider support ([#509](https://github.com/Gitlawb/openclaude/issues/509)) ([43ac6db](https://github.com/Gitlawb/openclaude/commit/43ac6dba75537282da1e2ad8f855082bc4e25f1e))
* add NVIDIA NIM and MiniMax provider support ([#552](https://github.com/Gitlawb/openclaude/issues/552)) ([51191d6](https://github.com/Gitlawb/openclaude/commit/51191d61326e1f8319d70b3a3c0d9229e185a564))
* add ripgrep to Dockerfile for faster file searching ([#688](https://github.com/Gitlawb/openclaude/issues/688)) ([12dd375](https://github.com/Gitlawb/openclaude/commit/12dd3755c619cc27af3b151ae8fdb9d425a7b9a2))
* **api:** classify openai-compatible provider failures ([#708](https://github.com/Gitlawb/openclaude/issues/708)) ([80a00ac](https://github.com/Gitlawb/openclaude/commit/80a00acc2c6dc4657a78de7366f7a9ebc920bfbb))
* **vscode:** add full chat interface to OpenClaude extension ([#608](https://github.com/Gitlawb/openclaude/issues/608)) ([fbcd928](https://github.com/Gitlawb/openclaude/commit/fbcd928f7f8511da795aea3ad318bddf0ab9a1a7))


### Bug Fixes

* focus "Done" option after completing provider manager actions ([#718](https://github.com/Gitlawb/openclaude/issues/718)) ([d6f5130](https://github.com/Gitlawb/openclaude/commit/d6f5130c204d8ffe582212466768706cd7fd6774))
* **models:** prevent /models crash from non-string saved model values ([#691](https://github.com/Gitlawb/openclaude/issues/691)) ([6b2121d](https://github.com/Gitlawb/openclaude/commit/6b2121da12189fa7ce1f33394d18abd24cf8a01b))
* prevent crash in commands tab when description is undefined ([#730](https://github.com/Gitlawb/openclaude/issues/730)) ([eed77e6](https://github.com/Gitlawb/openclaude/commit/eed77e6579866a98384dcc948a0ad6406614ede3))
* strip comments before scanning for missing imports ([#676](https://github.com/Gitlawb/openclaude/issues/676)) ([a00b792](https://github.com/Gitlawb/openclaude/commit/a00b7928de9662ffb7ef6abd8cd040afe6f4f122))
* **ui:** show correct endpoint URL in intro screen for custom Anthropic endpoints ([#735](https://github.com/Gitlawb/openclaude/issues/735)) ([3424663](https://github.com/Gitlawb/openclaude/commit/34246635fb9a09499047a52e7f96ca9b36c8a85a))

## [0.3.0](https://github.com/Gitlawb/openclaude/compare/v0.2.3...v0.3.0) (2026-04-14)


### Features

* activate coordinator mode in open build ([#647](https://github.com/Gitlawb/openclaude/issues/647)) ([99a1714](https://github.com/Gitlawb/openclaude/commit/99a17144ee285b892a0801acb6abcc9af68879af))
* activate local-only team memory in open build ([#648](https://github.com/Gitlawb/openclaude/issues/648)) ([24d485f](https://github.com/Gitlawb/openclaude/commit/24d485f42f5b1405d2fab13f2f497d5edd3b5300))
* activate message actions in open build ([#632](https://github.com/Gitlawb/openclaude/issues/632)) ([252808b](https://github.com/Gitlawb/openclaude/commit/252808bbd0a12a6ccf97e2cb09752a0212ea3acd))
* add allowBypassPermissionsMode setting ([#658](https://github.com/Gitlawb/openclaude/issues/658)) ([31be66d](https://github.com/Gitlawb/openclaude/commit/31be66d7645ea3473334c9ce89ea1a5095b8df6e))
* add Docker image build and push to GHCR on release ([#656](https://github.com/Gitlawb/openclaude/issues/656)) ([658d076](https://github.com/Gitlawb/openclaude/commit/658d076909e14eb0459bcb98aee9aa0472118265))
* implement /loop command with fixed and dynamic scheduling ([#621](https://github.com/Gitlawb/openclaude/issues/621)) ([64298a6](https://github.com/Gitlawb/openclaude/commit/64298a663f1391b16aa1f5a49e8a877e1d3742f2))
* implement Monitor tool for streaming shell output ([#649](https://github.com/Gitlawb/openclaude/issues/649)) ([b818dd5](https://github.com/Gitlawb/openclaude/commit/b818dd5958f4e8428566ce25a1a6be5fd4fe66f8))
* local feature flag overrides via ~/.claude/feature-flags.json ([#639](https://github.com/Gitlawb/openclaude/issues/639)) ([0e48884](https://github.com/Gitlawb/openclaude/commit/0e48884f56c6c008f047a7926d3b2cb924170625))
* open useful USER_TYPE-gated features to all users ([#644](https://github.com/Gitlawb/openclaude/issues/644)) ([c1beea9](https://github.com/Gitlawb/openclaude/commit/c1beea98676a413c54152a45a6b9fbe7fb9ed028))


### Bug Fixes

* bump axios 1.14.0 → 1.15.0 (Dependabot [#4](https://github.com/Gitlawb/openclaude/issues/4), [#5](https://github.com/Gitlawb/openclaude/issues/5)) ([#670](https://github.com/Gitlawb/openclaude/issues/670)) ([a07e5ef](https://github.com/Gitlawb/openclaude/commit/a07e5ef990a5ed01a72e83fdbd1fcab36f515a08))
* extend provider guard to protect anthropic profiles from cross-terminal override ([#641](https://github.com/Gitlawb/openclaude/issues/641)) ([03e0b06](https://github.com/Gitlawb/openclaude/commit/03e0b06e0784e4ea46945b3950840b10b6e3ca49))
* improve fetch diagnostics for bootstrap and session requests ([#646](https://github.com/Gitlawb/openclaude/issues/646)) ([df2b9f2](https://github.com/Gitlawb/openclaude/commit/df2b9f2b7b4c661ee3d9ed5dc58b3064de0599d1))
* **openai-shim:** preserve tool result images and local token caps ([#659](https://github.com/Gitlawb/openclaude/issues/659)) ([30c866d](https://github.com/Gitlawb/openclaude/commit/30c866d31ad8538496460667d86ed5efbd4a8547))
* replace broken bun:bundle shim with source pre-processing ([#657](https://github.com/Gitlawb/openclaude/issues/657)) ([adbe391](https://github.com/Gitlawb/openclaude/commit/adbe391e63721918b5d147f4f845111c1a3143db))
* resolve 12 bugs across API, MCP, agent tools, web search, and context overflow ([#674](https://github.com/Gitlawb/openclaude/issues/674)) ([25ce2ca](https://github.com/Gitlawb/openclaude/commit/25ce2ca7bff8937b0b79ad7f85c6dc1c68432069))
* route OpenAI Codex shortcuts to correct endpoint ([#566](https://github.com/Gitlawb/openclaude/issues/566)) ([7c8bdcc](https://github.com/Gitlawb/openclaude/commit/7c8bdcc3e2ac1ecb98286c705c85671044be3d6b))

## [0.2.3](https://github.com/Gitlawb/openclaude/compare/v0.2.2...v0.2.3) (2026-04-12)


### Bug Fixes

* prevent infinite auto-compact loop for unknown 3P models ([#635](https://github.com/Gitlawb/openclaude/issues/635)) ([#636](https://github.com/Gitlawb/openclaude/issues/636)) ([aeaa658](https://github.com/Gitlawb/openclaude/commit/aeaa658f776fb8df95721e8b8962385f8b00f66a))

## [0.2.2](https://github.com/Gitlawb/openclaude/compare/v0.2.1...v0.2.2) (2026-04-12)


### Bug Fixes

* **read/edit:** make compact line prefix unambiguous for tab-indented files ([#613](https://github.com/Gitlawb/openclaude/issues/613)) ([08cc6f3](https://github.com/Gitlawb/openclaude/commit/08cc6f328711cd93ce9fa53351266c29a0b0a341))

## [0.2.1](https://github.com/Gitlawb/openclaude/compare/v0.2.0...v0.2.1) (2026-04-12)


### Bug Fixes

* **provider:** add recovery guidance for missing OpenAI API key ([#616](https://github.com/Gitlawb/openclaude/issues/616)) ([9419e8a](https://github.com/Gitlawb/openclaude/commit/9419e8a4a21b3771d9ddb10f7072e0a8c5b5b631))

## [0.2.0](https://github.com/Gitlawb/openclaude/compare/v0.1.8...v0.2.0) (2026-04-12)


### Features

* add /cache-probe diagnostic command ([#580](https://github.com/Gitlawb/openclaude/issues/580)) ([9ccaa7a](https://github.com/Gitlawb/openclaude/commit/9ccaa7a6759b6991f4a566b4118c06e68a2398fe)), closes [#515](https://github.com/Gitlawb/openclaude/issues/515)
* add auto-fix service — auto-lint and test after AI file edits ([#508](https://github.com/Gitlawb/openclaude/issues/508)) ([c385047](https://github.com/Gitlawb/openclaude/commit/c385047abba4366866f4c87bfb5e0b0bd4dcbb9d))
* Add Gemini support with thought_signature fix  ([#404](https://github.com/Gitlawb/openclaude/issues/404)) ([5012c16](https://github.com/Gitlawb/openclaude/commit/5012c160c9a2dff9418e7ee19dc9a4d29ef2b024))
* add headless gRPC server for external agent integration ([#278](https://github.com/Gitlawb/openclaude/issues/278)) ([26eef92](https://github.com/Gitlawb/openclaude/commit/26eef92fe72e9c3958d61435b8d3571e12bf2b74))
* add wiki mvp commands ([#532](https://github.com/Gitlawb/openclaude/issues/532)) ([c328fdf](https://github.com/Gitlawb/openclaude/commit/c328fdf9e2fe59ad101b049301298ce9ff24caca))
* GitHub provider lifecycle and onboarding hardening ([#351](https://github.com/Gitlawb/openclaude/issues/351)) ([ff7d499](https://github.com/Gitlawb/openclaude/commit/ff7d49990de515825ddbe4099f3a39b944b61370))


### Bug Fixes

* add File polyfill for Node &lt; 20 to prevent startup deadlock with proxy ([#442](https://github.com/Gitlawb/openclaude/issues/442)) ([85aa8b0](https://github.com/Gitlawb/openclaude/commit/85aa8b0985c8f3cb8801efa5141114a0ab0f6a83))
* add GitHub Copilot model context windows and output limits ([#576](https://github.com/Gitlawb/openclaude/issues/576)) ([a7f5982](https://github.com/Gitlawb/openclaude/commit/a7f5982f6438ab0ddc3f0daae31ea68ac7ac206c)), closes [#515](https://github.com/Gitlawb/openclaude/issues/515)
* add LiteLLM-style aliases for GitHub Copilot context windows ([#606](https://github.com/Gitlawb/openclaude/issues/606)) ([2e0e14d](https://github.com/Gitlawb/openclaude/commit/2e0e14d71313e0e501efaa9e55c6c56f2742fb10))
* add store:false to Chat Completions and /responses fallback ([#578](https://github.com/Gitlawb/openclaude/issues/578)) ([8aaa4f2](https://github.com/Gitlawb/openclaude/commit/8aaa4f22ac5b942d82aa9cad54af30d56034515a))
* address code scanning alerts ([#434](https://github.com/Gitlawb/openclaude/issues/434)) ([e365cb4](https://github.com/Gitlawb/openclaude/commit/e365cb4010becabacd7cbccb4c3e59ea23a41e90))
* avoid sync github credential reads in provider manager ([#428](https://github.com/Gitlawb/openclaude/issues/428)) ([aff2bd8](https://github.com/Gitlawb/openclaude/commit/aff2bd87e4f2821992f74fb95481c505d0ba5d5d))
* convert dragged file paths to [@mentions](https://github.com/mentions) for attachment ([#382](https://github.com/Gitlawb/openclaude/issues/382)) ([112df59](https://github.com/Gitlawb/openclaude/commit/112df5911791ea71ee9efbb98ea59c5ded1ea161))
* custom web search — WEB_URL_TEMPLATE not recognized, timeout too short, silent native fallback ([#537](https://github.com/Gitlawb/openclaude/issues/537)) ([32fbd0c](https://github.com/Gitlawb/openclaude/commit/32fbd0c7b4168b32dcb13a5b69342e2727269201))
* defer startup checks and suppress recommendation dialogs during startup window (issue [#363](https://github.com/Gitlawb/openclaude/issues/363)) ([#504](https://github.com/Gitlawb/openclaude/issues/504)) ([2caf2fd](https://github.com/Gitlawb/openclaude/commit/2caf2fd982af1ec845c50152ad9d28d1a597f82f))
* display selected model in startup screen instead of hardcoded sonnet 4.6 ([#587](https://github.com/Gitlawb/openclaude/issues/587)) ([b126e38](https://github.com/Gitlawb/openclaude/commit/b126e38b1affddd2de83fcc3ba26f2e44b42a509))
* handle missing skill parameter in SkillTool ([#485](https://github.com/Gitlawb/openclaude/issues/485)) ([f9ce81b](https://github.com/Gitlawb/openclaude/commit/f9ce81bfb384e909353813fb6f6760cadd508ae7))
* include MCP tool results in microcompact to reduce token waste ([#348](https://github.com/Gitlawb/openclaude/issues/348)) ([52d33a8](https://github.com/Gitlawb/openclaude/commit/52d33a87a047b943aedaaaf772cd48636c263509))
* **ink:** restore host prop updates in React 19 reconciler ([#589](https://github.com/Gitlawb/openclaude/issues/589)) ([6e94dd9](https://github.com/Gitlawb/openclaude/commit/6e94dd913688b2d6433a9abe62a245c5f031b776))
* let saved provider profiles win on restart ([#513](https://github.com/Gitlawb/openclaude/issues/513)) ([cb8f8b7](https://github.com/Gitlawb/openclaude/commit/cb8f8b7ac2e3e74516ee219a3a48156db7c6ed78))
* normalize malformed Bash tool arguments from OpenAI-compatible providers ([#385](https://github.com/Gitlawb/openclaude/issues/385)) ([b4bd95b](https://github.com/Gitlawb/openclaude/commit/b4bd95b47715c9896240d708c106777507fd26ec))
* preserve only originally-required properties in strict tool schemas ([#471](https://github.com/Gitlawb/openclaude/issues/471)) ([ccaa193](https://github.com/Gitlawb/openclaude/commit/ccaa193eec5761f0972ffb58eb3189a81a9244b0))
* preserve unicode in Windows clipboard fallback ([#388](https://github.com/Gitlawb/openclaude/issues/388)) ([c193497](https://github.com/Gitlawb/openclaude/commit/c1934974aaf64db460cc850a044bd13cc744cce7))
* rebrand prompt identity to openclaude ([#496](https://github.com/Gitlawb/openclaude/issues/496)) ([598651f](https://github.com/Gitlawb/openclaude/commit/598651f42389ce76311ec00e8a9c701c939ead27))
* replace isDeepStrictEqual with navigation-aware options comparison ([#507](https://github.com/Gitlawb/openclaude/issues/507)) ([537c469](https://github.com/Gitlawb/openclaude/commit/537c469c3a2f7cb0eed05fa2f54dca57b6bc273f)), closes [#472](https://github.com/Gitlawb/openclaude/issues/472)
* report cache reads in streaming and correct cost calculation ([#577](https://github.com/Gitlawb/openclaude/issues/577)) ([f4ac709](https://github.com/Gitlawb/openclaude/commit/f4ac709fa6eda732bf45204fcab625ba6c5674b9))
* restore default context window for unknown 3p models ([#494](https://github.com/Gitlawb/openclaude/issues/494)) ([69ea1f1](https://github.com/Gitlawb/openclaude/commit/69ea1f1e4a99e9436215d8cb391a116a64442b94))
* restore Grep and Glob reliability on OpenAI paths ([#461](https://github.com/Gitlawb/openclaude/issues/461)) ([600c01f](https://github.com/Gitlawb/openclaude/commit/600c01faf761a080a2c7dede872ddbe05a132f23))
* restore Ollama auto-detect in first-run setup ([#561](https://github.com/Gitlawb/openclaude/issues/561)) ([68c2968](https://github.com/Gitlawb/openclaude/commit/68c296833dcef54ce44cb18b24357230b5204dbc))
* scrub canonical Anthropic headers from 3P shim requests ([#499](https://github.com/Gitlawb/openclaude/issues/499)) ([07621a6](https://github.com/Gitlawb/openclaude/commit/07621a6f8d0918170281869a47b5dbff90e71594))
* strip Anthropic params from 3P resume paths ([#479](https://github.com/Gitlawb/openclaude/issues/479)) ([4975cfc](https://github.com/Gitlawb/openclaude/commit/4975cfc2e0ddbe34aa4e8e3f52ee5eba07fbe465))
* suppress startup dialogs when input is buffered ([#423](https://github.com/Gitlawb/openclaude/issues/423)) ([8ece290](https://github.com/Gitlawb/openclaude/commit/8ece2900872dadd157e798ef501ddf126dac66c4))
* **tui:** restore prompt rendering on startup ([#498](https://github.com/Gitlawb/openclaude/issues/498)) ([e30ad17](https://github.com/Gitlawb/openclaude/commit/e30ad17ae0056787273be2caafd6cf5340b6ab57))
* update theme preview on focus change ([#562](https://github.com/Gitlawb/openclaude/issues/562)) ([6924718](https://github.com/Gitlawb/openclaude/commit/692471850fc789ee0797190089272407f9a4d953))
* **web-search:** close SSRF bypasses in custom provider hostname guard ([#610](https://github.com/Gitlawb/openclaude/issues/610)) ([a02c441](https://github.com/Gitlawb/openclaude/commit/a02c44143b257fbee7f38f1b93873cc0ea68a1f9))
* WebSearch providers + MCPTool bugs ([#593](https://github.com/Gitlawb/openclaude/issues/593)) ([91e4cfb](https://github.com/Gitlawb/openclaude/commit/91e4cfb15b62c04615834fd3c417fe38b4feb914))
