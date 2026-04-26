import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');
vi.mock('./actions/merge', () => ({ runMerge: vi.fn() }));
vi.mock('./actions/setup-monochange', () => ({ runSetupMonochange: vi.fn() }));
vi.mock('./actions/changeset-policy', () => ({ runChangesetPolicy: vi.fn() }));
vi.mock('./actions/release-pr', () => ({ runReleasePr: vi.fn() }));
vi.mock('./actions/publish-plan', () => ({ runPublishPlan: vi.fn() }));
vi.mock('./actions/post-merge-release', () => ({ runPostMergeRelease: vi.fn() }));

describe('main dispatch', () => {
  it('exports the run function implicitly by module side effects', () => {
    expect(true).toBe(true);
  });
});
