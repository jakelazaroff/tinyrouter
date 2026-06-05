format:
	@./vendor/oxfmt/macos

typecheck:
	@./vendor/typescript/macos --noEmit -p jsconfig.json
