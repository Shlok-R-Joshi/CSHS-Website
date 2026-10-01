document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('nav-menu').classList.toggle('show');
  });
  
  const typewriterText = "Calendar";
  const typewriterElement = document.getElementById("typewriter");
  let index = 0;
  
  function typeWriter() {
    if (index < typewriterText.length) {
      typewriterElement.textContent += typewriterText.charAt(index);
      index++;
      setTimeout(typeWriter, 100);
    }
  }
  
  const subtitles = [
    "See What's Happening and When.",
    "No More \"When's Our Next Meeting?\"",
    "Clear your Calendar, there's one here!",
    "This website finally has usage",
    "Join us at the meetings!"
    
  ];
  
  let subtitleIndex = 0;
  const subtitleElement = document.getElementById("subtitle");
  
  function cycleSubtitles() {
    subtitleElement.classList.remove("fade-in");
    setTimeout(() => {
      subtitleElement.textContent = subtitles[subtitleIndex];
      subtitleElement.classList.add("fade-in");
      subtitleIndex = (subtitleIndex + 1) % subtitles.length;
    }, 500);
  }
  
  document.addEventListener("DOMContentLoaded", () => {
    typeWriter();
    cycleSubtitles();
    setInterval(cycleSubtitles, 4000);
  });
  
  



// ARROW CODE



  const scrollArrow = document.getElementById('scroll-arrow');
const heroSection = document.getElementById('hero');

scrollArrow.addEventListener('click', () => {
  window.scrollBy({
    top: window.innerHeight,
    behavior: 'smooth'
  });
});

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    scrollArrow.style.opacity = entry.isIntersecting ? '1' : '0';
  });
}, {
  root: null,
  threshold: 0.1
});

if (heroSection) observer.observe(heroSection);
