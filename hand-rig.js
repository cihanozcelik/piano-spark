// Original WebXR generic-hand skins, posed through logical finger chains.
// See assets/hands/README.md for the asset, skinning and CCD references.
export class PianoHandRig {
  constructor(THREE, gltf, hand, {scale=1}={}) {
    this.THREE=THREE;this.hand=hand;this.scale=scale;
    this.group=new THREE.Group();this.group.name='Piano '+hand+' hand';
    this.group.scale.setScalar(scale);
    this.scene=gltf.scene;this.scene.updateMatrixWorld(true);
    this.meshes=[];this.bones=new Map();
    this.scene.traverse(node=> {
      if(node.isSkinnedMesh) {
        this.meshes.push(node);
        for(const bone of node.skeleton.bones) this.bones.set(bone.name,bone);
      }
    });
    this._meshBindWorld=new Map(this.meshes.map(mesh=>[mesh,mesh.matrixWorld.clone()]));
    const wrist=this.bones.get('wrist');
    const wristMatrix=wrist.matrixWorld.clone(),inverseWrist=wristMatrix.clone().invert();
    const wristQuaternion=wrist.getWorldQuaternion(new THREE.Quaternion());
    const inverseWristQuaternion=wristQuaternion.clone().invert();
    this.rest=new Map();
    for(const [name,bone] of this.bones) this.rest.set(name,{
      position:bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseWrist),
      quaternion:inverseWristQuaternion.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion())),
    });
    const normalizer=new THREE.Group();normalizer.name='Wrist bind normalization';
    normalizer.applyMatrix4(inverseWrist);
    normalizer.add(this.scene);this.group.add(normalizer);
    this._worldPosition=new THREE.Vector3();this._worldQuaternion=new THREE.Quaternion();
    this._parentQuaternion=new THREE.Quaternion();this._groupQuaternion=new THREE.Quaternion();
    this._frameMatrix=new THREE.Matrix4();this._side=new THREE.Vector3();this._up=new THREE.Vector3();
    this._forward=new THREE.Vector3();this._delta=new THREE.Quaternion();
    this._target=new THREE.Vector3();this._direction=new THREE.Vector3();this._dorsal=new THREE.Vector3();
    this._neutral=new THREE.Vector3();
    this._frameQuaternion=new THREE.Quaternion();
    this._requests=new Array(6).fill(null);
    this.chains=new Array(6).fill(null);
    this.restTips=new Array(6).fill(null);this.bindTips=new Array(6).fill(null);
    this.fingerReach=new Array(6).fill(0);this.contactErrors=new Array(6).fill(0);
    this._evaluatedErrors=new Float64Array(6);
    // The rig owns visual inertia, independently of the lesson's transport.
    // Slots 0..3 are wrist XYZ/yaw; each finger then owns abduction + 3 hinges.
    this.motionPosition=new Float64Array(24);
    this.motionVelocity=new Float64Array(24);
    this.motionReady=false;
    this.moving=false;
    this.motionWrist=[0,0,0];
    this._tips=Array.from({length:6},()=>new THREE.Vector3());
    this._canonicalTips=Array.from({length:6},()=>new THREE.Vector3());
    this._ownedGeometries=new Set();this._ownedMaterials=new Set();this._ownedTextures=new Set();
    this.prepareMaterials(inverseWrist);
    const names=['thumb','index-finger','middle-finger','ring-finger','pinky-finger'];
    const degrees=Math.PI/180;
    for(let finger=1;finger<=5;finger++) {
      const name=names[finger-1];
      const joints=finger===1?['metacarpal','phalanx-proximal','phalanx-distal','tip']:
        ['phalanx-proximal','phalanx-intermediate','phalanx-distal','tip'];
      const jointNames=joints.map(joint=>name+'-'+joint);
      const positions=jointNames.map(joint=>this.rest.get(joint).position);
      const lengths=positions.slice(1).map((point,index)=>point.distanceTo(positions[index]));
      const direction=positions[3].clone().sub(positions[0]);
      const neutral=(finger===1?[-9,30,24]:[-12,48,30]).map(value=>value*degrees);
      const chain={finger,jointNames,base:positions[0],lengths,
        yaw:Math.atan2(direction.x,-direction.z),yawLimit:(finger===1?95:42)*degrees,
        neutral,angles:new Float64Array(neutral),
        min:(finger===1?[-35,0,0]:[-28,0,0]).map(value=>value*degrees),
        max:(finger===1?[70,85,75]:[82,105,78]).map(value=>value*degrees),
        plane:Array.from({length:4},()=>({x:0,y:0})),
        points:Array.from({length:4},()=>new THREE.Vector3()),
        frames:[],padRadius:finger===1?.0045:.0038,
      };
      for(let index=0;index<3;index++) {
        const forward=positions[index+1].clone().sub(positions[index]).normalize();
        chain.frames.push(this.frame(forward,new THREE.Vector3(0,1,0),new THREE.Quaternion()).invert());
      }
      this.chains[finger]=chain;
      this.solve(chain,null);
      this.restTips[finger]=chain.points[3].clone().addScaledVector(new THREE.Vector3(0,1,0),-chain.padRadius).multiplyScalar(scale);
      this.bindTips[finger]=positions[3].clone().multiplyScalar(scale);
      this.fingerReach[finger]=lengths.reduce((sum,length)=>sum+length,0)*scale;
      this.prepareNail(chain,positions,inverseWrist);
    }
    this.pose({wrist:[0,0,0],targets:[],yaw:0});
    this.motionReady=false;
  }

  prepareMaterials(inverseWrist) {
    const T=this.THREE,size=128,data=new Uint8Array(size*size);
    let seed=419;
    for(let index=0;index<data.length;index++) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      data[index]=114+((seed>>>24)%29);
    }
    const pores=new T.DataTexture(data,size,size,T.RedFormat);
    pores.wrapS=pores.wrapT=T.RepeatWrapping;pores.repeat.set(12,12);pores.needsUpdate=true;
    this._ownedTextures.add(pores);
    const skin=new T.MeshPhysicalMaterial({color:0xffffff,vertexColors:true,metalness:0,roughness:.61,
      clearcoat:.035,clearcoatRoughness:.55,sheen:.13,sheenColor:new T.Color('#c59077'),sheenRoughness:.82,
      bumpMap:pores,bumpScale:.00012});
    skin.name='Warm matte teaching skin';this._ownedMaterials.add(skin);
    const base=new T.Color('#d5ae91'),flush=new T.Color('#bd8b79'),color=new T.Color(),point=new T.Vector3();
    for(const mesh of this.meshes) {
      const geometry=mesh.geometry,positions=geometry.getAttribute('position');
      const colors=new Float32Array(positions.count*3);
      for(let index=0;index<positions.count;index++) {
        point.fromBufferAttribute(positions,index).applyMatrix4(this._meshBindWorld.get(mesh)).applyMatrix4(inverseWrist);
        const fingertip=Math.max(0,Math.min(1,(-point.z-.11)/.08));
        const variation=Math.sin(point.x*841+point.y*469+point.z*719)*.012;
        color.copy(base).lerp(flush,fingertip*.12).multiplyScalar(1+variation);
        colors[index*3]=color.r;colors[index*3+1]=color.g;colors[index*3+2]=color.b;
      }
      geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));
      const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
      for(const material of materials) material.dispose();
      mesh.material=skin;mesh.castShadow=true;mesh.receiveShadow=true;
      // Skinning changes the bind-pose bounds; two teaching hands do not need
      // per-frame bounds scans or stale-bind-pose frustum culling.
      mesh.frustumCulled=false;this._ownedGeometries.add(geometry);
    }
  }

  prepareNail(chain,positions,inverseWrist) {
    const T=this.THREE;
    if(!this.nailGeometry) {
      this.nailGeometry=new T.SphereGeometry(1,20,10);
      this.nailMaterial=new T.MeshPhysicalMaterial({color:'#dabca8',metalness:0,roughness:.36,clearcoat:.1,clearcoatRoughness:.3});
      this._ownedGeometries.add(this.nailGeometry);this._ownedMaterials.add(this.nailMaterial);
    }
    const start=positions[2],end=positions[3],axis=end.clone().sub(start).normalize();
    const dorsal=new T.Vector3(0,1,0).addScaledVector(axis,-axis.y).normalize();
    const point=new T.Vector3(),offset=new T.Vector3();
    let surface=.0035;
    for(const mesh of this.meshes) {
      const vertices=mesh.geometry.getAttribute('position');
      for(let index=0;index<vertices.count;index++) {
        point.fromBufferAttribute(vertices,index).applyMatrix4(this._meshBindWorld.get(mesh)).applyMatrix4(inverseWrist);
        offset.copy(point).sub(start);
        const along=offset.dot(axis),radial=offset.clone().addScaledVector(axis,-along);
        if(along>chain.lengths[2]*.2&&along<chain.lengths[2]*.9&&radial.length()<.009) {
          surface=Math.max(surface,radial.dot(dorsal));
        }
      }
    }
    const nail=new T.Mesh(this.nailGeometry,this.nailMaterial);
    nail.name=this.hand+' finger '+chain.finger+' nail';
    const halfWidth=chain.finger===1?.0044:chain.finger===5?.0027:.0034;
    nail.scale.set(halfWidth,.00035,chain.lengths[2]*.34);
    nail.castShadow=false;nail.receiveShadow=true;
    chain.nail=nail;chain.nailOffset=surface*.94;
    this.group.add(nail);
  }

  frame(forward,up,result) {
    this._side.crossVectors(up,forward).normalize();
    this._up.crossVectors(forward,this._side).normalize();
    this._frameMatrix.makeBasis(this._side,this._up,forward);
    return result.setFromRotationMatrix(this._frameMatrix);
  }

  forward(chain) {
    let angle=0,x=0,y=0;
    chain.plane[0].x=chain.plane[0].y=0;
    for(let index=0;index<3;index++) {
      angle+=chain.angles[index];
      x+=Math.cos(angle)*chain.lengths[index];y+=Math.sin(angle)*chain.lengths[index];
      chain.plane[index+1].x=x;chain.plane[index+1].y=y;
    }
  }

  solve(chain,target) {
    chain.angles.set(chain.neutral);
    let yaw=chain.yaw;
    if(target) {
      const dx=target.x-chain.base.x,dz=target.z-chain.base.z;
      const proposed=Math.atan2(dx,-dz);
      const delta=Math.atan2(Math.sin(proposed-chain.yaw),Math.cos(proposed-chain.yaw));
      yaw+=Math.max(-chain.yawLimit,Math.min(chain.yawLimit,delta));
      const goalX=dx*Math.sin(yaw)-dz*Math.cos(yaw),goalY=chain.base.y-target.y;
      // Planar cyclic coordinate descent. PIP and DIP are flexion hinges;
      // MCP/CMC abduction is solved separately, preserving all bone lengths.
      for(let iteration=0;iteration<22;iteration++) {
        this.forward(chain);
        if(Math.hypot(chain.plane[3].x-goalX,chain.plane[3].y-goalY)<.00025) break;
        for(let joint=2;joint>=0;joint--) {
          this.forward(chain);
          const pivot=chain.plane[joint],end=chain.plane[3];
          const ax=end.x-pivot.x,ay=end.y-pivot.y,bx=goalX-pivot.x,by=goalY-pivot.y;
          const turn=Math.atan2(ax*by-ay*bx,ax*bx+ay*by);
          chain.angles[joint]=Math.max(chain.min[joint],Math.min(chain.max[joint],chain.angles[joint]+Math.max(-.3,Math.min(.3,turn))));
        }
      }
    }
    chain.solvedYaw=yaw;
    this.placeChain(chain);
  }

  placeChain(chain) {
    this.forward(chain);
    const yaw=chain.solvedYaw;
    for(let index=0;index<4;index++) chain.points[index].set(
      chain.base.x+Math.sin(yaw)*chain.plane[index].x,
      chain.base.y-chain.plane[index].y,
      chain.base.z-Math.cos(yaw)*chain.plane[index].x);
  }

  writeJoint(name,position,quaternion) {
    const bone=this.bones.get(name);
    this._worldPosition.copy(position);this.group.localToWorld(this._worldPosition);
    bone.position.copy(bone.parent.worldToLocal(this._worldPosition));
    bone.parent.getWorldQuaternion(this._parentQuaternion).invert();
    this._worldQuaternion.copy(this._groupQuaternion).multiply(quaternion);
    bone.quaternion.copy(this._parentQuaternion.multiply(this._worldQuaternion));
  }

  evaluatePose({wrist,targets=[],yaw=0}) {
    // Contact-only evaluation shares the exact pose solver. Candidate wrist
    // searches never update the skin, nail transforms or scene hierarchy.
    // The returned error buffer is reused; consume it before the next call.
    const cosine=Math.cos(yaw),sine=Math.sin(yaw),scale=this.scale;
    this._requests.fill(null);
    for(const target of targets) this._requests[target.finger]=target;
    for(let finger=1;finger<=5;finger++) {
      const chain=this.chains[finger],request=this._requests[finger];
      let target=null;
      if(request) {
        const dx=request.position[0]-wrist[0],dy=request.position[1]-wrist[1],dz=request.position[2]-wrist[2];
        this._target.set((cosine*dx-sine*dz)/scale,dy/scale,(sine*dx+cosine*dz)/scale);
        this._neutral.copy(this.restTips[finger]).divideScalar(scale);
        this._target.lerpVectors(this._neutral,this._target,Math.max(0,Math.min(1,request.weight??1)));
        this._target.y+=chain.padRadius;target=this._target;
      }
      this.solve(chain,target);
      const tip=chain.points[3];
      this._evaluatedErrors[finger]=request?Math.hypot(
        wrist[0]+scale*(cosine*tip.x+sine*tip.z)-request.position[0],
        wrist[1]+scale*(tip.y-chain.padRadius)-request.position[1],
        wrist[2]+scale*(-sine*tip.x+cosine*tip.z)-request.position[2]):0;
    }
    return this._evaluatedErrors;
  }

  followMotion(slot,target,seconds,frequency,maxSpeed,maxAcceleration,epsilon,initial) {
    if(initial) {
      this.motionPosition[slot]=target;
      this.motionVelocity[slot]=0;
      return target;
    }
    let position=this.motionPosition[slot],velocity=this.motionVelocity[slot];
    // Substeps bound the numerical integration even after a slow render frame.
    const steps=Math.max(1,Math.ceil(seconds*120)),step=seconds/steps;
    for(let index=0;index<steps;index++) {
      const acceleration=Math.max(-maxAcceleration,Math.min(maxAcceleration,
        frequency*frequency*(target-position)-2*frequency*velocity));
      velocity=Math.max(-maxSpeed,Math.min(maxSpeed,velocity+acceleration*step));
      position+=velocity*step;
    }
    if(Math.abs(position-target)<epsilon&&Math.abs(velocity)<epsilon*frequency) {
      position=target;velocity=0;
    } else this.moving=true;
    this.motionPosition[slot]=position;this.motionVelocity[slot]=velocity;
    return position;
  }

  pose({wrist,targets=[],yaw=0,deltaSeconds=0}) {
    const initial=!this.motionReady;
    const seconds=Math.max(0,Math.min(.05,deltaSeconds));
    this.moving=false;
    // Authored visual limits: metres/s and metres/s² for translation;
    // radians/s and radians/s² for rotation. They are not anatomical limits.
    for(let axis=0;axis<3;axis++) this.motionWrist[axis]=this.followMotion(
      axis,wrist[axis],seconds,22,1.1,6,.00001,initial);
    const actualYaw=this.followMotion(3,yaw,seconds,24,3,20,.0001,initial);
    // Solve contacts against the moving wrist, then move the joints continuously
    // toward that solution. An IK branch change can never teleport a finger.
    this.evaluatePose({wrist:this.motionWrist,targets,yaw:actualYaw});
    for(let finger=1;finger<=5;finger++) {
      const chain=this.chains[finger],slot=4+(finger-1)*4;
      chain.solvedYaw=this.followMotion(slot,chain.solvedYaw,seconds,32,8,90,.0001,initial);
      for(let joint=0;joint<3;joint++) {
        const value=this.followMotion(slot+joint+1,chain.angles[joint],seconds,36,12,120,.0001,initial);
        chain.angles[joint]=Math.max(chain.min[joint],Math.min(chain.max[joint],value));
        if(chain.angles[joint]!==value) {
          this.motionPosition[slot+joint+1]=chain.angles[joint];
          this.motionVelocity[slot+joint+1]=0;
        }
      }
      this.placeChain(chain);
    }
    this.motionReady=true;
    this.group.position.fromArray(this.motionWrist);this.group.rotation.set(0,actualYaw,0);
    this.group.updateMatrixWorld(true);this.group.getWorldQuaternion(this._groupQuaternion);
    for(const [name,rest] of this.rest) this.writeJoint(name,rest.position,rest.quaternion);
    for(let finger=1;finger<=5;finger++) {
      const chain=this.chains[finger];
      let angle=0;
      for(let joint=0;joint<4;joint++) {
        const segment=Math.min(joint,2);
        if(joint<3) angle+=chain.angles[joint];
        this._forward.copy(chain.points[segment+1]).sub(chain.points[segment]).normalize();
        this._dorsal.set(Math.sin(chain.solvedYaw)*Math.sin(angle),Math.cos(angle),-Math.cos(chain.solvedYaw)*Math.sin(angle));
        this.frame(this._forward,this._dorsal,this._frameQuaternion);
        this._delta.copy(this._frameQuaternion).multiply(chain.frames[segment]);
        this._delta.multiply(this.rest.get(chain.jointNames[joint]).quaternion);
        this.writeJoint(chain.jointNames[joint],chain.points[joint],this._delta);
      }
      chain.nail.position.copy(chain.points[2]).lerp(chain.points[3],.56).addScaledVector(this._dorsal,chain.nailOffset);
      chain.nail.quaternion.copy(this._frameQuaternion);
      this._canonicalTips[finger].copy(chain.points[3]);this._canonicalTips[finger].y-=chain.padRadius;
      this._tips[finger].copy(this._canonicalTips[finger]);this.group.localToWorld(this._tips[finger]);
      const request=this._requests[finger];
      this.contactErrors[finger]=request?this._tips[finger].distanceTo(this._target.fromArray(request.position)):0;
    }
    this.group.updateMatrixWorld(true);
    return this;
  }

  tip(finger) { return this._tips[finger]; }

  setScale(value) {
    const ratio=value/this.scale;
    this.scale=value;this.group.scale.setScalar(value);
    for(let finger=1;finger<=5;finger++) {
      this.restTips[finger].multiplyScalar(ratio);
      this.bindTips[finger].multiplyScalar(ratio);
      this.fingerReach[finger]*=ratio;
    }
    this.group.updateMatrixWorld(true);
    for(let finger=1;finger<=5;finger++) {
      this._tips[finger].copy(this._canonicalTips[finger]);this.group.localToWorld(this._tips[finger]);
    }
    return this;
  }

  dispose() {
    this.group.removeFromParent();
    for(const geometry of this._ownedGeometries) geometry.dispose();
    for(const material of this._ownedMaterials) material.dispose();
    for(const texture of this._ownedTextures) texture.dispose();
  }
}
