// Linkage names vanilla SWFs export (SymbolClass), for scene.imports — names only, pinned in
// test/fixtures/art/vanilla-exports.json and checked against the installed game (T1). Pure.

export const VANILLA_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "catparts.swf": ["CatBody", "CatEar", "CatEye", "CatEyeClosed", "CatEyeClosed_Right", "CatEye_Right", "CatEyebrow", "CatHead", "CatHeadPlacements", "CatLeg", "CatMouth", "CatMouthOpen", "CatMouthSmile", "CatTail", "CatTexture", "FaceItemB", "FaceItemF", "FaceItemIcon", "FaceItemIcon_Broken", "FaceItemIcon_Worn", "HeadItemB", "HeadItemF", "HeadItemIcon", "HeadItemIcon_Broken", "HeadItemIcon_Worn", "NeckItemB", "NeckItemF", "NeckItemIcon", "NeckItemIcon_Broken", "NeckItemIcon_Worn", "Trinket", "TrinketIcon", "TrinketIcon_Broken", "TrinketIcon_Worn", "Weapon", "WeaponIcon", "WeaponIcon_Broken", "WeaponIcon_Worn"],
};

/** A symbol another game SWF exports, placed by keys like a sprite (written as ImportAssets2 { id, name }). */
export interface SceneImport {
  /** the game SWF, e.g. catparts.swf */
  from: string;
  /** its linkage name, e.g. CatTail */
  name: string;
}
