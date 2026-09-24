// The running binary's version: `lane --version`, and the default `toolVersion` recorded in
// a done overlay (advance) and compared against one before re-writing it (calibrate /
// usage-import, issue #50). One constant so those defaults cannot drift apart -- a
// calibrate defaulting to an older version than the advance that created the overlay
// would refuse every post-done write as "written by a newer lane". Bumped at release time.
export const LANE_VERSION = "0.10.1";
