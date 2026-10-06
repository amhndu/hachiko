// Hard limits. Every number here is enforced somewhere in code, and spec.md
// section 6 lists them; change both together.
export const LIMITS = {
	maxWatches: 25,
	maxFields: 8,
	maxSelectorLen: 300,
	maxPatternLen: 200,
	maxAnchorLen: 80,
	maxPredicateLen: 2000,

	// The sandbox: one Dynamic Worker per evaluation, no network, no bindings.
	sandboxCpuMs: 50,
	sandboxWallMs: 2000,
	maxSandboxInputBytes: 32_768,
	maxSummaryLen: 280,

	// The browser.
	navTimeoutMs: 30_000,
	waitForTimeoutMs: 10_000,
	maxFieldTextLen: 500,
	maxMatchesPerField: 20,
	outlineMaxItems: 500,
	outlineMaxChars: 40_000,
	pickerMaxHeight: 3000,
	pickerMaxBoxes: 1500,

	// Scheduling and healing.
	minIntervalMinutes: 15,
	maxHealAttemptsPerRun: 2,
	maxHealsPerDay: 3,
	errorStreakToNotify: 3,
	runningStaleMinutes: 15,
	runsKeptPerWatch: 200,
	draftTtlHours: 24,
} as const;
