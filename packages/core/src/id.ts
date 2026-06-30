import { randomUUID } from "node:crypto";

/** Injectable id generator. */
export type IdGen = () => string;

export const uuid: IdGen = () => randomUUID();
