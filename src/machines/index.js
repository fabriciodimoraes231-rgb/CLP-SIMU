// Registro das máquinas disponíveis. Para criar uma nova, siga o formato de conveyor.js:
// { id, name, description, size, inputs, outputs, controls, extras, createSim, render, exampleProgram }
// Opcionais: analogs (entradas analógicas → IW e registradores Modbus) e examples (vários exemplos).
import { conveyor } from './conveyor.js';
import { tank } from './tank.js';

export const MACHINES = [conveyor, tank];

/** Programas de exemplo da máquina: [{ id, name, desc, program() }]. O primeiro é o padrão. */
export const machineExamples = (m) => m.examples
  ?? [{ id: 'exemplo', name: 'Programa de exemplo', desc: '', program: m.exampleProgram }];
