/** Wire types for POST /v1/systemone (TypeSafe Jev). */

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;         // option key -> description (the description is the prompt)
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];                       // ordered levels, 2..10
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;                            // weighted mean over level indices
  confidence: number;
  legend: Record<string, string>;           // index -> level text
  probabilities: Record<string, number>;    // index -> p
}
export interface NoulAnswer {
  type: "noul";
  noul: number;                             // P(statement is true)
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface JevRequest {
  model?: string;
  state: unknown;                           // string | object | string[]
  questions: Record<string, Question>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
  quota?: { used: number; limit: number; remaining: number };
}

export interface Jev {
  ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse>;
}
