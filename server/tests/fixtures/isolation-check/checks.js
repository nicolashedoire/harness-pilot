export const title = 'A useful page without session access';
export async function denied(fn){try{await fn();return false;}catch{return true;}}
