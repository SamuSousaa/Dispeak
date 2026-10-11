type Listener = (name: string) => void;

/**
 * Lets something outside the chat (the menu on a person) put a mention into the message being
 * written. Only one composer listens at a time: the one of the channel on screen.
 */
let listener: Listener | null = null;

/** Registers the composer that receives mentions. Returns the function that unregisters it. */
export function onMentionRequest(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/** Whether a message is being written somewhere a mention can go. */
export function canMention(): boolean {
  return listener !== null;
}

/** Adds `@name` to the message being written; does nothing when there is none. */
export function requestMention(name: string): void {
  listener?.(name);
}
