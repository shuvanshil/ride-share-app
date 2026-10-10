import os
from PIL import Image

def generate():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    logo_path = os.path.join(root, 'www', 'assets', 'branding', 'liphtup-logo.jpeg')
    icon_path = os.path.join(root, 'www', 'assets', 'icons', 'liphtup-icon-1024.png')
    
    icon_img = Image.open(icon_path).convert('RGBA')
    # Crop the logo with a small padding
    crop = icon_img.crop((50, 360, 930, 680))
    crop_data = crop.load()
    
    # Make background pixels pure white and transparent or opaque white
    clean_logo = Image.new('RGBA', crop.size, (255, 255, 255, 255))
    clean_data = clean_logo.load()
    for y in range(crop.height):
        for x in range(crop.width):
            r, g, b, a = crop_data[x, y]
            if r >= 245 and g >= 245 and b >= 245:
                clean_data[x, y] = (255, 255, 255, 255)
            else:
                clean_data[x, y] = (r, g, b, a)

    splash_specs = [
        ('android/app/src/main/res/drawable/splash.png', 480, 320, 'land'),
        ('android/app/src/main/res/drawable-land-mdpi/splash.png', 480, 320, 'land'),
        ('android/app/src/main/res/drawable-land-hdpi/splash.png', 800, 480, 'land'),
        ('android/app/src/main/res/drawable-land-xhdpi/splash.png', 1280, 720, 'land'),
        ('android/app/src/main/res/drawable-land-xxhdpi/splash.png', 1600, 960, 'land'),
        ('android/app/src/main/res/drawable-land-xxxhdpi/splash.png', 1920, 1280, 'land'),
        ('android/app/src/main/res/drawable-port-mdpi/splash.png', 320, 480, 'port'),
        ('android/app/src/main/res/drawable-port-hdpi/splash.png', 480, 800, 'port'),
        ('android/app/src/main/res/drawable-port-xhdpi/splash.png', 720, 1280, 'port'),
        ('android/app/src/main/res/drawable-port-xxhdpi/splash.png', 960, 1600, 'port'),
        ('android/app/src/main/res/drawable-port-xxxhdpi/splash.png', 1280, 1920, 'port'),
    ]

    for rel_path, w, h, orient in splash_specs:
        out_path = os.path.join(root, rel_path.replace('/', os.sep))
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        
        splash = Image.new('RGB', (w, h), (255, 255, 255))
        
        if orient == 'port':
            max_w = int(w * 0.68)
            max_h = int(h * 0.25)
        else:
            max_w = int(w * 0.50)
            max_h = int(h * 0.38)
            
        scale = min(max_w / clean_logo.width, max_h / clean_logo.height)
        nw = max(1, int(clean_logo.width * scale))
        nh = max(1, int(clean_logo.height * scale))
        
        resized = clean_logo.resize((nw, nh), Image.Resampling.LANCZOS)
        
        pos_x = (w - nw) // 2
        pos_y = (h - nh) // 2
        splash.paste(resized, (pos_x, pos_y), resized)
        splash.save(out_path, format='PNG')
        print(f'Generated splash: {rel_path} ({w}x{h})')

    # Notification silhouette icon generation
    # Extract tight bounding box of colored logo
    tight_crop = icon_img.crop((98, 406, 885, 635))
    sil_hi = Image.new('RGBA', tight_crop.size, (0, 0, 0, 0))
    sil_data = sil_hi.load()
    t_data = tight_crop.load()
    for y in range(tight_crop.height):
        for x in range(tight_crop.width):
            r, g, b, a = t_data[x, y]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum < 240:
                alpha = int(min(255, max(0, (1.0 - (lum / 240.0)) * 255)))
                sil_data[x, y] = (255, 255, 255, alpha)

    notif_specs = [
        ('android/app/src/main/res/drawable', 48),
        ('android/app/src/main/res/drawable-mdpi', 24),
        ('android/app/src/main/res/drawable-hdpi', 36),
        ('android/app/src/main/res/drawable-xhdpi', 48),
        ('android/app/src/main/res/drawable-xxhdpi', 72),
        ('android/app/src/main/res/drawable-xxxhdpi', 96),
    ]

    for rel_folder, size in notif_specs:
        folder_path = os.path.join(root, rel_folder.replace('/', os.sep))
        os.makedirs(folder_path, exist_ok=True)
        
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        pad = max(2, int(size * 0.12))
        inner_w = size - 2 * pad
        inner_h = size - 2 * pad
        scale = min(inner_w / sil_hi.width, inner_h / sil_hi.height)
        nw = max(1, int(sil_hi.width * scale))
        nh = max(1, int(sil_hi.height * scale))
        
        resized = sil_hi.resize((nw, nh), Image.Resampling.LANCZOS)
        pos_x = (size - nw) // 2
        pos_y = (size - nh) // 2
        canvas.paste(resized, (pos_x, pos_y), resized)
        
        for name in ['ic_stat_liphtup.png', 'ic_stat_name.png']:
            dest = os.path.join(folder_path, name)
            canvas.save(dest, format='PNG')
            print(f'Generated notif icon: {dest} ({size}x{size})')

if __name__ == '__main__':
    generate()
