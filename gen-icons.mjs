  import sharp from 'sharp';
  await sharp('icons/logo.svg').resize(192,192).png().toFile('icons/icon-192.png');
  await sharp('icons/logo.svg').resize(512,512).png().toFile('icons/icon-512.png');