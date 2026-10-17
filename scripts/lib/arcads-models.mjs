export const arcadsImages = [
    ['gpt-image-2','GPT Image 2'], ['gpt-image-2.5','GPT Image 2.5'],
    ['nano-banana-2.1','Nano Banana 2.1'], ['seedream-5-pro','Seedream 5 Pro'],
];
export const arcadsVideos = [
    ['kling-3.0','Kling 3.0',3,15,'480p',false],
    ['MiniMax-H3','MiniMax H3',5,15,'480p',true],
    ['minimax-h3-max','MiniMax H3 Max',5,15,'480p',true],
    ['seedance','Seedance',4,12,'480p',true],
    ['seedance-2.0','Seedance 2.0',4,15,'480p',true],
    ['seedance-2.0-mini','Seedance 2.0 Mini',4,15,'480p',true],
    ['seedance-2.5','Seedance 2.5',4,30,'480p',true],
    ['veo-3.1','Veo 3.1',8,8,'480p',true],
    ['wan-3.0','Wan 3.0',2,30,'480p',true],
    ['grok-video','Grok Video',1,15,'480p',false],
];
export function videoProfile([model,label,min,max,resolution,reference]) {
    const capabilities=['text-to-video','image-to-video',...(reference?['reference-to-video']:[])];
    return {capabilities,customBodyParameters:{},videoBillingConfiguration:{billingUnit:'second',defaultResolution:resolution,minimumDurationSeconds:min,
        supportedDurationsSeconds:Array.from({length:max-min+1},(_,i)=>i+min),
        modePrices:Object.fromEntries(capabilities.map(mode=>[mode,{[resolution]:10}]))}};
}
