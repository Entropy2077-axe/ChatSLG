import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { BottomNav } from '../components/BottomNav'
import { useSettingsStore } from '../store/useSettingsStore'
import { moveAssetToTrash, permanentlyDeleteAsset, restoreAsset } from '../lib/mediaAssets'
import { reportImageDisplayError } from '../lib/atlasImage'

export function AlbumPage() {
  const [trash,setTrash]=useState(false), [selected,setSelected]=useState<string[]>([])
  const showPrivate=useSettingsStore((s)=>s.showPrivateImages)
  const assets=useLiveQuery(()=>db.mediaAssets.orderBy('createdAt').reverse().filter((a)=>trash?!!a.deletedAt:!a.deletedAt).toArray(),[trash])??[]
  const toggle=(id:string)=>setSelected((rows)=>rows.includes(id)?rows.filter((x)=>x!==id):[...rows,id])
  async function act(kind:'trash'|'restore'|'delete'){ for(const id of selected) await (kind==='trash'?moveAssetToTrash(id):kind==='restore'?restoreAsset(id):permanentlyDeleteAsset(id)); setSelected([]) }
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title={trash?'回收站':'相册'} showBack/><div className="flex shrink-0 gap-2 bg-white px-4 py-2"><button onClick={()=>{setTrash(false);setSelected([])}} className={`rounded-full px-3 py-1 text-xs ${!trash?'bg-gray-900 text-white':'bg-gray-100'}`}>全部图片</button><button onClick={()=>{setTrash(true);setSelected([])}} className={`rounded-full px-3 py-1 text-xs ${trash?'bg-gray-900 text-white':'bg-gray-100'}`}>回收站</button></div><main className="min-h-0 flex-1 overflow-y-auto p-2">{assets.length===0?<p className="py-20 text-center text-sm text-gray-400">这里还没有图片</p>:<div className="grid grid-cols-3 gap-1">{assets.map((asset)=>{const url=asset.dataUrl||asset.remoteUrl;return <button key={asset.id} onClick={()=>toggle(asset.id)} className={`relative aspect-square overflow-hidden bg-gray-200 ${selected.includes(asset.id)?'ring-2 ring-violet-500':''}`}>{url?<img src={url} alt="" onError={()=>void reportImageDisplayError(asset.id,'相册缩略图在当前设备中加载失败')} className={`h-full w-full object-cover ${asset.sensitive&&!showPrivate?'scale-105 blur-xl':''}`}/>:<span className="px-2 text-xs text-gray-500">{asset.status==='failed'?(asset.error||'图片加载失败'):asset.status}</span>}<span className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[9px] text-white">{asset.source==='atlas'?'AI':'Pexels'}</span>{selected.includes(asset.id)&&<span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 text-xs text-white">✓</span>}</button>})}</div>}</main>{selected.length>0&&<div className="shrink-0 border-t bg-white p-3"><button onClick={()=>void act(trash?'restore':'trash')} className="mr-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white">{trash?'恢复':'移入回收站'}（{selected.length}）</button>{trash&&<button onClick={()=>window.confirm('彻底删除后无法恢复，确定继续？')&&void act('delete')} className="rounded-lg bg-red-500 px-4 py-2 text-sm text-white">彻底删除</button>}</div>}<BottomNav/></div>
}
