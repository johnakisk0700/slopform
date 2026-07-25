export class ConversationPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = ConversationPersistenceError.name;
  }
}
