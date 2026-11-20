/**
 * A polite status region that stays mounted while its text changes.
 * WebKit (VoiceOver) ignores live regions inserted together with their
 * content, so async results must update an element that already exists.
 */
export function LiveStatus({ message }: { message?: string | null }) {
  return (
    <p className="visually-hidden" role="status">
      {message}
    </p>
  );
}
