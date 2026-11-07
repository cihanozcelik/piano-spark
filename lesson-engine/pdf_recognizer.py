"""Job-scoped PDF recognition in the bundled Python/ONNX environment, without Java."""
import json
import os
from pathlib import Path
import sys


def main():
    os.environ['OMP_NUM_THREADS']='4'
    os.environ['OPENBLAS_NUM_THREADS']='4'
    os.environ['VECLIB_MAXIMUM_THREADS']='4'
    import cv2
    cv2.setNumThreads(2)
    import pypdfium2 as pdfium
    from homr.main import ProcessingConfig, process_image
    from homr.music_xml_generator import XmlGeneratorArguments

    source,manifest=map(Path,sys.argv[1:])
    os.nice(5)
    document=pdfium.PdfDocument(str(source))
    config=ProcessingConfig(False,False,False,False,-1,False,False,False)
    settings=XmlGeneratorArguments(False,None,None)
    paths=[]
    try:
        for index in range(len(document)):
            print(json.dumps(dict(event='lesson-progress',phase='notation',
                                  message=f'PDF notaları okunuyor: {index+1}/{len(document)}',
                                  progress=.12+.65*index/len(document)),ensure_ascii=False),flush=True)
            image=manifest.parent/f'page-{index+1:04d}.png'
            page=document[index]
            bitmap=page.render(scale=3)
            try:bitmap.to_pil().save(image)
            finally:bitmap.close();page.close()
            process_image(str(image),config,settings)
            paths.append(str(image.with_suffix('.musicxml')))
        manifest.write_text(json.dumps(paths))
    finally:document.close()


if __name__=='__main__':main()
