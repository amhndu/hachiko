// Hard limits. Every number here is enforced somewhere in code, and spec.md
// section 6 lists them; change both together.
//
// Sized for the Workers Free plan. The binding constraint is Browser Run's
// 10 browser-minutes a day: a check costs roughly 3-5 s of browser time, so
// 5 hourly watches (120 checks) use about 8 minutes and leave room for
// drafts, heals and the picker. Workers AI's 10k free neurons a day cover
// roughly 25-30 compiles or heals with the default compiler model, which is
// why the outline sent to it is capped at 16k chars.
export const LIMITS = {
	maxWatches: 5,
	maxFields: 8,
	maxSelectorLen: 300,
	maxMarkerLen: 80,
	maxAnchorLen: 80,

	// The condition: data, evaluated by a small interpreter (condition.ts).
	maxConditionClauses: 8,
	maxConditionStringLen: 200,
	maxSummaryTemplateLen: 200,
	maxSummaryLen: 280,

	// The browser.
	browserLaunchIntervalMs: 20_000,
	navTimeoutMs: 30_000,
	pageSettleTimeoutMs: 5_000,
	waitForTimeoutMs: 10_000,
	maxFieldTextLen: 500,
	maxMatchesPerField: 20,
	outlineMaxItems: 300,
	outlineMaxChars: 16_000,
	pickerMaxHeight: 3000,
	pickerMaxBoxes: 1500,

	// Scheduling and healing.
	minIntervalMinutes: 60,
	maxHealAttemptsPerRun: 2,
	maxHealsPerDay: 3,
	errorStreakToNotify: 3,
	runningStaleMinutes: 15,
	runsKeptPerWatch: 200,
	draftTtlHours: 24,
} as const;
