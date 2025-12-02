import * as readline from 'readline';

export class ReadlineHelper {
  private readlineInterface: readline.Interface;

  constructor() {
    this.readlineInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  public async askQuestion(question: string): Promise<string> {
    return new Promise(resolve => {
      this.readlineInterface.question(question, answer => {
        resolve(answer.trim());
      });
    });
  }

  public close(): void {
    this.readlineInterface.close();
  }
}

