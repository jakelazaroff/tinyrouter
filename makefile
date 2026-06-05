format:
	@./vendor/oxfmt/macos

typecheck:
	@./vendor/typescript/macos --noEmit -p jsconfig.json

test:
	@node --test tinyrouter.test.js
