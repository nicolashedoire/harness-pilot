from pathlib import Path
import json

def handle(ctx,method,path,query,body):
    if path=='status':
        return {'bridge':'ok','echo':(Path(ctx['state_dir'])/'echo.txt').read_text() if (Path(ctx['state_dir'])/'echo.txt').exists() else '', 'unexpected_project':(Path(ctx['workspace'])/'projects/isolation-bypass').exists()}
    if path=='echo' and method=='POST':
        p=Path(ctx['state_dir'])/'echo.txt'
        p.write_text(str((body or {}).get('text','')))
        return {'saved':p.read_text()=='essai'}
    raise LookupError('Unknown test endpoint')
