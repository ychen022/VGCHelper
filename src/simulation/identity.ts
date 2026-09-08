/** Battle-form aliases used only for party identity, never for damage stats. */
export function speciesIdentity(value:string):string {
  return value.split(',')[0]!.toLowerCase().replace(/[^a-z0-9]/g,'')
    .replace(/^floettemega$/,'floetteeternal').replace(/mega[xy]?$/,'')
    .replace(/^aegislash(?:shield|blade)$/,'aegislash').replace(/^floetteeternalflower$/,'floetteeternal');
}
