export type CommentMode = 'always' | 'never' | 'on-error';

export function normalizeCommentMode(input: string | undefined): CommentMode {
  const value = (input ?? 'on-error').trim().toLowerCase();

  switch (value) {
    case '1':
    case 'always':
    case 'true':
      return 'always';
    case '0':
    case 'false':
    case 'never':
      return 'never';
    case 'on-error':
    case '':
      return 'on-error';
    default:
      throw new Error(
        `Input \`comment\` must be one of always, never, on-error, true, or false. Received \`${input}\`.`,
      );
  }
}

export function shouldPostComment(mode: CommentMode, failed: boolean): boolean {
  switch (mode) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'on-error':
      return failed;
  }
}

export function serializeCommentOutput(body: string): string {
  return JSON.stringify({ body }, null, 2);
}
