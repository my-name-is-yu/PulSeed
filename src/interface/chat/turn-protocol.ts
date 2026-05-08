import type { ActiveChatTurn, ChatEventContext } from "./turn-state.js";
import type { UserInput } from "./user-input.js";

export type TurnOperation = TurnStartOperation | TurnSteerOperation;

export interface TurnStartOperation {
  kind: "TurnStart";
  turnId: string;
  runId: string;
  inputId: string;
  cwd: string;
  userInput: UserInput;
}

export interface TurnSteerOperation {
  kind: "TurnSteer";
  turnId: string;
  runId: string;
  steerInputId: string;
  activeTurn: {
    turnId: string;
    runId: string;
    cwd: string;
    startedAt: string;
  };
  userInput: UserInput;
}

export function createTurnStartOperation(input: {
  context: ChatEventContext;
  cwd: string;
  userInput: UserInput;
}): TurnStartOperation {
  return {
    kind: "TurnStart",
    turnId: input.context.turnId,
    runId: input.context.runId,
    inputId: crypto.randomUUID(),
    cwd: input.cwd,
    userInput: input.userInput,
  };
}

export function createTurnSteerOperation(input: {
  activeTurn: ActiveChatTurn;
  userInput: UserInput;
}): TurnSteerOperation {
  const { activeTurn } = input;
  return {
    kind: "TurnSteer",
    turnId: activeTurn.context.turnId,
    runId: activeTurn.context.runId,
    steerInputId: crypto.randomUUID(),
    activeTurn: {
      turnId: activeTurn.context.turnId,
      runId: activeTurn.context.runId,
      cwd: activeTurn.cwd,
      startedAt: new Date(activeTurn.startedAt).toISOString(),
    },
    userInput: input.userInput,
  };
}
